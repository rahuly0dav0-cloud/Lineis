"""Stage 1 - ingest raw core-banking extracts into the staging zone.

Foundation datasets are the raw_* core-banking files. This script reads them,
applies light cleaning, and writes the stg_* staging datasets consumed by the
downstream SAS enrichment step.
"""
import pandas as pd


def clean_customers() -> None:
    customers = pd.read_csv("core_banking/raw_customers.csv")
    customers = customers[customers["status"] != "DELETED"]
    customers["country"] = customers["country"].str.upper()
    customers.to_parquet("staging/stg_customers.parquet")


def clean_accounts() -> None:
    accounts = pd.read_csv("core_banking/raw_accounts.csv")
    accounts = accounts.dropna(subset=["account_id", "customer_id"])
    accounts.to_parquet("staging/stg_accounts.parquet")


def build_transactions() -> None:
    txns = pd.read_csv("core_banking/raw_transactions.csv")
    fx = pd.read_csv("reference/fx_rates.csv")
    enriched = txns.merge(fx, on="currency", how="left")
    enriched["amount_eur"] = enriched["amount"] * enriched["rate_to_eur"]
    enriched.to_parquet("staging/stg_transactions.parquet")


def build_collateral() -> None:
    collateral = pd.read_csv("core_banking/raw_collateral.csv")
    collateral.to_parquet("staging/stg_collateral.parquet")


if __name__ == "__main__":
    clean_customers()
    clean_accounts()
    build_transactions()
    build_collateral()
