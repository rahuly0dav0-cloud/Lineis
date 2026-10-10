"""============================================================================
Mortgage FINREP pipeline - STAGE 1: ingestion & staging (Python / pandas+spark).

Reads raw mortgage core-banking extracts and reference data, applies cleaning,
currency conversion and light feature engineering, then writes the stg_* staging
datasets consumed by the downstream SAS enrichment step (02_enrich.sas).

Deliberately "tricky" for a lineage parser:
  * pandas AND pyspark read/write styles
  * chained merges, concat, groupby-aggregations
  * intermediate DataFrames that must resolve to physical sources
  * reads from several source systems (core, reference, market, servicing)
============================================================================"""
from __future__ import annotations

import pandas as pd
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("mortgage_ingest").getOrCreate()

RAW = "s3://corebank-raw"
REF = "s3://corebank-reference"
STG = "s3://corebank-staging"


# ---------------------------------------------------------------------------
# 1. Mortgage accounts: core system + product reference
# ---------------------------------------------------------------------------
def build_mortgage_accounts() -> None:
    accounts = pd.read_csv(f"{RAW}/mortgage/raw_mortgage_accounts.csv")
    products = pd.read_csv(f"{REF}/ref_mortgage_products.csv")

    accounts = accounts[accounts["account_status"] != "CLOSED"]
    accounts["origination_year"] = pd.to_datetime(
        accounts["origination_date"]).dt.year

    enriched = accounts.merge(products, on="product_code", how="left")
    enriched["is_fixed_rate"] = enriched["rate_type"].eq("FIXED")
    enriched.to_parquet(f"{STG}/stg_mortgage_accounts.parquet")


# ---------------------------------------------------------------------------
# 2. Borrowers: core customers + KYC + credit bureau reference
# ---------------------------------------------------------------------------
def build_borrowers() -> None:
    customers = pd.read_csv(f"{RAW}/mortgage/raw_borrowers.csv")
    kyc = pd.read_csv(f"{RAW}/mortgage/raw_kyc_status.csv")
    bureau = pd.read_csv(f"{REF}/ref_credit_bureau.csv")

    base = customers.merge(kyc, on="customer_id", how="left")
    base = base.merge(bureau, on="customer_id", how="left")

    base["country"] = base["country"].str.upper()
    base["bureau_score"] = base["bureau_score"].fillna(base["bureau_score"].median())
    base["income_band"] = pd.cut(
        base["annual_income"],
        bins=[0, 25000, 50000, 100000, 1_000_000],
        labels=["LOW", "MID", "HIGH", "VHIGH"],
    )
    base.to_parquet(f"{STG}/stg_borrowers.parquet")


# ---------------------------------------------------------------------------
# 3. Payments: servicing system history + FX normalisation (pyspark)
# ---------------------------------------------------------------------------
def build_payments() -> None:
    payments = spark.read.parquet(f"{RAW}/servicing/raw_payments.parquet")
    fx = spark.read.option("header", True).csv(f"{REF}/ref_fx_rates.csv")

    joined = payments.join(fx, on="currency", how="left")
    joined = joined.withColumn(
        "amount_eur", joined["amount"] * joined["rate_to_eur"])
    joined.write.mode("overwrite").parquet(f"{STG}/stg_payments.parquet")


# ---------------------------------------------------------------------------
# 4. Properties / collateral: valuations + geography reference
# ---------------------------------------------------------------------------
def build_properties() -> None:
    properties = pd.read_csv(f"{RAW}/mortgage/raw_properties.csv")
    valuations = pd.read_csv(f"{RAW}/mortgage/raw_valuations.csv")
    geo = pd.read_csv(f"{REF}/ref_geography.csv")

    latest = (valuations.sort_values("valuation_date")
              .groupby("property_id", as_index=False).last())
    merged = properties.merge(latest, on="property_id", how="left")
    merged = merged.merge(geo, on="postcode_area", how="left")
    merged["ltv_source_value"] = merged["valuation_amount"].fillna(
        merged["purchase_price"])
    merged.to_parquet(f"{STG}/stg_properties.parquet")


# ---------------------------------------------------------------------------
# 5. FX snapshot passthrough for the SAS layer
# ---------------------------------------------------------------------------
def build_fx_snapshot() -> None:
    fx = pd.read_csv(f"{REF}/ref_fx_rates.csv")
    fx = fx[["currency", "rate_to_eur", "rate_date"]]
    fx.to_parquet(f"{STG}/stg_fx.parquet")


# ---------------------------------------------------------------------------
# 6. Arrears events: union of two servicing feeds (concat)
# ---------------------------------------------------------------------------
def build_arrears_events() -> None:
    legacy = pd.read_csv(f"{RAW}/servicing/raw_arrears_legacy.csv")
    current = pd.read_csv(f"{RAW}/servicing/raw_arrears_current.csv")

    legacy["source_system"] = "LEGACY"
    current["source_system"] = "CURRENT"
    events = pd.concat([legacy, current], ignore_index=True)
    events = events[events["days_past_due"] > 0]
    events.to_parquet(f"{STG}/stg_arrears_events.parquet")


# ---------------------------------------------------------------------------
# 7. Escrow: property tax and insurance balances held on behalf of borrowers
# ---------------------------------------------------------------------------
def build_escrow() -> None:
    tax = pd.read_csv(f"{RAW}/servicing/raw_property_tax.csv")
    insurance = pd.read_csv(f"{RAW}/servicing/raw_insurance_premiums.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")

    tax_agg = (tax.groupby("account_id", as_index=False)["tax_amount"]
               .sum().rename(columns={"tax_amount": "annual_tax"}))
    ins_agg = (insurance.groupby("account_id", as_index=False)["premium_amount"]
               .sum().rename(columns={"premium_amount": "annual_premium"}))

    escrow = accounts[["account_id"]].merge(tax_agg, on="account_id", how="left")
    escrow = escrow.merge(ins_agg, on="account_id", how="left")
    escrow["annual_tax"] = escrow["annual_tax"].fillna(0)
    escrow["annual_premium"] = escrow["annual_premium"].fillna(0)
    escrow["monthly_escrow"] = (escrow["annual_tax"] + escrow["annual_premium"]) / 12.0
    escrow.to_parquet(f"{STG}/stg_escrow.parquet")


# ---------------------------------------------------------------------------
# 8. Servicing events: payment holidays and loan modifications (pyspark)
# ---------------------------------------------------------------------------
def build_servicing_events() -> None:
    holidays = spark.read.parquet(f"{RAW}/servicing/raw_payment_holidays.parquet")
    mods = spark.read.option("header", True).csv(f"{RAW}/servicing/raw_modifications.csv")

    holidays = holidays.withColumn("event_type", holidays["holiday_type"])
    combined = holidays.join(mods, on="account_id", how="outer")
    combined = combined.withColumn(
        "is_forborne", combined["modification_flag"] == "Y")
    combined.write.mode("overwrite").parquet(f"{STG}/stg_servicing_events.parquet")


# ---------------------------------------------------------------------------
# 9. Credit bureau history: time-series of external scores (chained merges)
# ---------------------------------------------------------------------------
def build_bureau_history() -> None:
    history = pd.read_csv(f"{RAW}/reference/raw_bureau_history.csv")
    borrowers = pd.read_parquet(f"{STG}/stg_borrowers.parquet")
    defaults = pd.read_csv(f"{REF}/ref_default_register.csv")

    latest = (history.sort_values("score_date")
              .groupby("customer_id", as_index=False).last())
    enriched = borrowers.merge(latest, on="customer_id", how="left")
    enriched = enriched.merge(defaults, on="customer_id", how="left")
    enriched["has_prior_default"] = enriched["default_date"].notna()
    enriched["score_trend"] = (enriched["bureau_score"]
                               - enriched["bureau_score_prev"]).fillna(0)
    enriched.to_parquet(f"{STG}/stg_bureau_history.parquet")


# ---------------------------------------------------------------------------
# 10. Interest accruals: daily accrual roll-up per account (pyspark aggregate)
# ---------------------------------------------------------------------------
def build_interest_accruals() -> None:
    accruals = spark.read.parquet(f"{RAW}/servicing/raw_daily_accruals.parquet")
    accounts = spark.read.parquet(f"{STG}/stg_mortgage_accounts.parquet")

    joined = accruals.join(accounts, on="account_id", how="inner")
    joined = joined.withColumn(
        "accrued_interest_eur", joined["daily_accrual"] * joined["days_in_period"])
    joined.write.mode("overwrite").parquet(f"{STG}/stg_interest_accruals.parquet")


# ---------------------------------------------------------------------------
# 11. Prepayments: early-redemption behaviour, scored against balances
# ---------------------------------------------------------------------------
def build_prepayments() -> None:
    redemptions = pd.read_csv(f"{RAW}/servicing/raw_redemptions.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")
    curves = pd.read_csv(f"{REF}/ref_prepayment_curves.csv")

    red = redemptions.merge(accounts, on="account_id", how="left")
    red = red.merge(curves, on="product_code", how="left")
    red["prepay_rate"] = (red["redeemed_amount"]
                          / red["outstanding_balance"].replace(0, pd.NA))
    red["prepay_band"] = pd.cut(
        red["prepay_rate"].fillna(0),
        bins=[-0.01, 0.02, 0.10, 0.25, 1.0],
        labels=["NONE", "LOW", "MEDIUM", "HIGH"],
    )
    red.to_parquet(f"{STG}/stg_prepayments.parquet")


# ---------------------------------------------------------------------------
# 12. Securitisation pool: loans flagged into SPV structures (filter + join)
# ---------------------------------------------------------------------------
def build_securitisation_pool() -> None:
    pool_ref = pd.read_csv(f"{REF}/ref_securitisation_pools.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")

    pooled = accounts.merge(pool_ref, on="account_id", how="inner")
    pooled = pooled[pooled["pool_status"] == "ACTIVE"]
    pooled["is_retained"] = pooled["tranche"].isin(["EQUITY", "MEZZ"])
    pooled.to_parquet(f"{STG}/stg_securitisation_pool.parquet")


# ---------------------------------------------------------------------------
# 13. Hedging positions: swaps mapped to the mortgage book (pyspark join)
# ---------------------------------------------------------------------------
def build_hedging_positions() -> None:
    swaps = spark.read.parquet(f"{RAW}/treasury/raw_interest_swaps.parquet")
    desig = spark.read.option("header", True).csv(f"{REF}/ref_hedge_designations.csv")

    joined = swaps.join(desig, on="swap_id", how="left")
    joined = joined.withColumn(
        "notional_eur", joined["notional"] * joined["fx_rate"])
    joined = joined.withColumn(
        "is_effective", joined["effectiveness_ratio"] >= 0.8)
    joined.write.mode("overwrite").parquet(f"{STG}/stg_hedging_positions.parquet")


# ---------------------------------------------------------------------------
# 14. Rating migrations: internal grade transitions over the period
# ---------------------------------------------------------------------------
def build_rating_migrations() -> None:
    snapshots = pd.read_csv(f"{RAW}/risk/raw_rating_snapshots.csv")
    borrowers = pd.read_parquet(f"{STG}/stg_borrowers.parquet")

    snapshots = snapshots.sort_values(["customer_id", "snapshot_date"])
    snapshots["prev_grade"] = snapshots.groupby("customer_id")["internal_grade"].shift(1)
    snapshots["migrated"] = (snapshots["internal_grade"]
                             != snapshots["prev_grade"]) & snapshots["prev_grade"].notna()
    latest = snapshots.groupby("customer_id", as_index=False).last()

    migrations = borrowers.merge(
        latest[["customer_id", "internal_grade", "prev_grade", "migrated"]],
        on="customer_id", how="left")
    migrations["notch_change"] = (migrations["internal_grade"]
                                  - migrations["prev_grade"]).fillna(0)
    migrations.to_parquet(f"{STG}/stg_rating_migrations.parquet")


# ---------------------------------------------------------------------------
# 15. Market curves: discount factors for the valuation and IRRBB layers
# ---------------------------------------------------------------------------
def build_market_curves() -> None:
    curves = pd.read_csv(f"{RAW}/market/raw_yield_curves.csv")
    tenors = pd.read_csv(f"{REF}/ref_tenor_buckets.csv")

    merged = curves.merge(tenors, on="tenor_code", how="left")
    merged["discount_factor"] = 1.0 / (1.0 + merged["zero_rate"]) ** merged["tenor_years"]
    pivoted = merged.pivot_table(
        index="curve_date", columns="tenor_bucket",
        values="discount_factor", aggfunc="mean").reset_index()
    pivoted.to_parquet(f"{STG}/stg_market_curves.parquet")


# ---------------------------------------------------------------------------
# 16. Valuation history: indexed property values for LTV re-statement
# ---------------------------------------------------------------------------
def build_valuation_history() -> None:
    history = pd.read_csv(f"{RAW}/collateral/raw_valuation_history.csv")
    index = pd.read_csv(f"{REF}/ref_house_price_index.csv")
    properties = pd.read_parquet(f"{STG}/stg_properties.parquet")

    hist = history.merge(index, on="region_code", how="left")
    hist["indexed_value"] = hist["original_value"] * hist["index_factor"]
    latest = hist.sort_values("valuation_date").groupby(
        "property_id", as_index=False).last()

    restated = properties.merge(
        latest[["property_id", "indexed_value"]], on="property_id", how="left")
    restated["indexed_value"] = restated["indexed_value"].fillna(
        restated["ltv_source_value"])
    restated.to_parquet(f"{STG}/stg_valuation_history.parquet")


# ---------------------------------------------------------------------------
# 17. Insurance coverage: mortgage protection and buildings cover
# ---------------------------------------------------------------------------
def build_insurance_coverage() -> None:
    policies = pd.read_csv(f"{RAW}/insurance/raw_policies.csv")
    claims = pd.read_csv(f"{RAW}/insurance/raw_claims.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")

    claim_agg = (claims.groupby("policy_id", as_index=False)["claim_amount"]
                 .sum().rename(columns={"claim_amount": "total_claims"}))
    cov = policies.merge(claim_agg, on="policy_id", how="left")
    cov = cov.merge(accounts[["account_id", "product_code"]],
                    on="account_id", how="inner")
    cov["total_claims"] = cov["total_claims"].fillna(0)
    cov["loss_ratio"] = cov["total_claims"] / cov["premium_paid"].replace(0, pd.NA)
    cov["is_lapsed"] = cov["policy_status"].eq("LAPSED")
    cov.to_parquet(f"{STG}/stg_insurance_coverage.parquet")


# ---------------------------------------------------------------------------
# 18. Customer contacts: latest address and channel preferences (dedup)
# ---------------------------------------------------------------------------
def build_customer_contacts() -> None:
    contacts = pd.read_csv(f"{RAW}/reference/raw_customer_contacts.csv")
    prefs = pd.read_csv(f"{RAW}/reference/raw_channel_prefs.csv")

    contacts = contacts.sort_values("updated_at").drop_duplicates(
        "customer_id", keep="last")
    merged = contacts.merge(prefs, on="customer_id", how="left")
    merged["marketing_opt_in"] = merged["consent_flag"].eq("Y")
    merged.to_parquet(f"{STG}/stg_customer_contacts.parquet")


# ---------------------------------------------------------------------------
# 19. Loan terms: amortisation schedule features (vectorised calcs)
# ---------------------------------------------------------------------------
def build_loan_terms() -> None:
    terms = pd.read_csv(f"{RAW}/mortgage/raw_loan_terms.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")

    merged = accounts.merge(terms, on="account_id", how="left")
    monthly_rate = merged["interest_rate"] / 12.0 / 100.0
    n = merged["term_months"].clip(lower=1)
    merged["monthly_instalment"] = (
        merged["original_principal"] * monthly_rate
        / (1 - (1 + monthly_rate) ** (-n))
    )
    merged["remaining_term"] = (merged["term_months"]
                                - merged["elapsed_months"]).clip(lower=0)
    merged["is_interest_only"] = merged["repayment_type"].eq("IO")
    merged.to_parquet(f"{STG}/stg_loan_terms.parquet")


# ---------------------------------------------------------------------------
# 20. Guarantees: third-party and government-backed guarantees (filter+merge)
# ---------------------------------------------------------------------------
def build_guarantees() -> None:
    guarantees = pd.read_csv(f"{RAW}/collateral/raw_guarantees.csv")
    guarantors = pd.read_csv(f"{REF}/ref_guarantors.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")

    g = guarantees.merge(guarantors, on="guarantor_id", how="left")
    g = g.merge(accounts[["account_id", "current_balance"]],
                on="account_id", how="inner")
    g = g[g["guarantee_status"] == "ACTIVE"]
    g["covered_amount_eur"] = g[["guarantee_amount", "current_balance"]].min(axis=1)
    g["is_sovereign"] = g["guarantor_type"].eq("SOVEREIGN")
    g.to_parquet(f"{STG}/stg_guarantees.parquet")


# ---------------------------------------------------------------------------
# 21. Stress scenarios: expand accounts across macro scenarios (cross join)
# ---------------------------------------------------------------------------
def build_stress_scenarios() -> None:
    scenarios = pd.read_csv(f"{REF}/ref_stress_scenarios.csv")
    accounts = pd.read_parquet(f"{STG}/stg_mortgage_accounts.parquet")

    accounts = accounts[["account_id", "current_balance", "product_code"]].copy()
    accounts["_key"] = 1
    scenarios["_key"] = 1
    expanded = accounts.merge(scenarios, on="_key").drop(columns="_key")
    expanded["stressed_balance_eur"] = (
        expanded["current_balance"] * (1 + expanded["balance_shock_pct"] / 100.0))
    expanded.to_parquet(f"{STG}/stg_stress_scenarios.parquet")


# ---------------------------------------------------------------------------
# 22. Branch reference: organisational hierarchy for reporting rollups
# ---------------------------------------------------------------------------
def build_branch_reference() -> None:
    branches = pd.read_csv(f"{REF}/ref_branches.csv")
    regions = pd.read_csv(f"{REF}/ref_regions.csv")

    merged = branches.merge(regions, on="region_code", how="left")
    merged["cost_centre"] = (merged["region_code"].astype(str)
                             + "-" + merged["branch_id"].astype(str))
    merged.to_parquet(f"{STG}/stg_branch_reference.parquet")


if __name__ == "__main__":
    build_mortgage_accounts()
    build_borrowers()
    build_payments()
    build_properties()
    build_fx_snapshot()
    build_arrears_events()
    build_escrow()
    build_servicing_events()
    build_bureau_history()
    build_interest_accruals()
    build_prepayments()
    build_securitisation_pool()
    build_hedging_positions()
    build_rating_migrations()
    build_market_curves()
    build_valuation_history()
    build_insurance_coverage()
    build_customer_contacts()
    build_loan_terms()
    build_guarantees()
    build_stress_scenarios()
    build_branch_reference()
    spark.stop()
