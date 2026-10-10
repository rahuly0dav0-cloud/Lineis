/* ============================================================================
   Mortgage FINREP pipeline - STAGE 2: enrichment (SAS).
   Reads the stg_* staging datasets produced by 01_ingest.py and builds the
   analytical mart tables consumed by the SQL regulatory layer (03_report.sql).

   Cross-language stitching: the stg_* inputs below are written by the Python
   ingest step; the mart.* outputs are read by the SQL reporting step.
   ============================================================================ */

libname stg  "/data/staging";
libname mart "/data/mart";

/* --------------------------------------------------------------------------
   1. Mortgage base: accounts + borrowers merged on customer_id
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_mortgage_accounts out=work.acc_sorted; by customer_id; run;
proc sort data=stg.stg_borrowers         out=work.bor_sorted; by customer_id; run;

data mart.mortgage_base;
    merge work.acc_sorted (in=a)
          work.bor_sorted (in=b);
    by customer_id;
    if a and b;
    length ltv_band $10;
    if current_balance = . then current_balance = 0;
run;

/* --------------------------------------------------------------------------
   2. Payment behaviour: aggregate the servicing payment history
   -------------------------------------------------------------------------- */

proc summary data=stg.stg_payments nway;
    class account_id;
    var amount_eur;
    output out=work.payment_agg (drop=_type_ _freq_)
           n=payment_count
           sum=total_paid_eur
           mean=avg_payment_eur;
run;

/* Flag thin payment files via a data step. */
data mart.payment_behaviour;
    set work.payment_agg;
    length payment_profile $12;
    if payment_count >= 24 then payment_profile = 'ESTABLISHED';
    else if payment_count >= 6 then payment_profile = 'SEASONED';
    else payment_profile = 'THIN';
run;

/* --------------------------------------------------------------------------
   3. Property valuation: latest valuation per account via PROC SQL
   -------------------------------------------------------------------------- */

proc sql;
    create table mart.property_valuation as
    select p.property_id,
           p.account_id,
           p.region,
           p.ltv_source_value,
           p.purchase_price,
           p.ltv_source_value as collateral_value_eur
    from stg.stg_properties as p
    where p.ltv_source_value > 0;
quit;

/* --------------------------------------------------------------------------
   4. Arrears summary: worst delinquency bucket per account
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_arrears_events out=work.arrears_sorted;
    by account_id descending days_past_due;
run;

data work.worst_arrears;
    set work.arrears_sorted;
    by account_id;
    if first.account_id;
    length delinquency_bucket $12;
    if days_past_due >= 90 then delinquency_bucket = 'DPD90PLUS';
    else if days_past_due >= 30 then delinquency_bucket = 'DPD30_89';
    else delinquency_bucket = 'DPD1_29';
run;

proc summary data=stg.stg_arrears_events nway;
    class account_id;
    var days_past_due;
    output out=work.arrears_stats (drop=_type_ _freq_)
           max=max_dpd
           n=arrears_event_count;
run;

proc sort data=work.worst_arrears out=work.worst_arrears; by account_id; run;
proc sort data=work.arrears_stats out=work.arrears_stats; by account_id; run;

data mart.arrears_summary;
    merge work.worst_arrears (in=w keep=account_id delinquency_bucket days_past_due)
          work.arrears_stats (in=s);
    by account_id;
    if w or s;
    if max_dpd = . then max_dpd = 0;
run;

/* --------------------------------------------------------------------------
   5. LTV & risk features: combine base + property + payments + arrears
   -------------------------------------------------------------------------- */

proc sort data=mart.mortgage_base       out=work.base_sorted; by account_id; run;
proc sort data=mart.property_valuation  out=work.prop_sorted; by account_id; run;
proc sort data=mart.payment_behaviour   out=work.pay_sorted;  by account_id; run;
proc sort data=mart.arrears_summary     out=work.arr_sorted;  by account_id; run;

data mart.mortgage_risk_features;
    merge work.base_sorted (in=base)
          work.prop_sorted (in=prop keep=account_id collateral_value_eur region)
          work.pay_sorted  (in=pay  keep=account_id payment_profile total_paid_eur)
          work.arr_sorted  (in=arr  keep=account_id delinquency_bucket max_dpd);
    by account_id;
    if base;

    if collateral_value_eur = . or collateral_value_eur = 0 then ltv_pct = .;
    else ltv_pct = current_balance / collateral_value_eur * 100;

    if ltv_pct = . then ltv_band = 'UNKNOWN';
    else if ltv_pct <= 60 then ltv_band = 'LE60';
    else if ltv_pct <= 80 then ltv_band = '60_80';
    else if ltv_pct <= 90 then ltv_band = '80_90';
    else ltv_band = 'GT90';

    if max_dpd = . then max_dpd = 0;
    if max_dpd >= 90 then ifrs9_stage = 3;
    else if max_dpd >= 30 then ifrs9_stage = 2;
    else ifrs9_stage = 1;
run;

/* --------------------------------------------------------------------------
   6. Forbearance candidates: data step filter feeding the SQL layer
   -------------------------------------------------------------------------- */

data mart.forbearance_candidates;
    set mart.mortgage_risk_features;
    where ifrs9_stage >= 2 or ltv_band = 'GT90';
    length forbearance_type $15;
    if ifrs9_stage = 3 then forbearance_type = 'RESTRUCTURE';
    else if ltv_band = 'GT90' then forbearance_type = 'TERM_EXTENSION';
    else forbearance_type = 'PAYMENT_HOLIDAY';
    keep account_id customer_id country ltv_band ifrs9_stage
         max_dpd forbearance_type current_balance;
run;

/* --------------------------------------------------------------------------
   7. Escrow enrichment: monthly escrow burden per account
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_escrow out=work.escrow_sorted; by account_id; run;

data mart.escrow_enriched;
    merge work.base_sorted   (in=base keep=account_id customer_id current_balance)
          work.escrow_sorted (in=esc  keep=account_id monthly_escrow annual_tax
                              annual_premium);
    by account_id;
    if base;
    if monthly_escrow = . then monthly_escrow = 0;
    if current_balance > 0
        then escrow_to_balance = monthly_escrow * 12 / current_balance;
        else escrow_to_balance = 0;
run;

/* --------------------------------------------------------------------------
   8. Bureau enrichment: external score banding per customer
   -------------------------------------------------------------------------- */

proc sql;
    create table mart.bureau_enriched as
    select b.customer_id,
           b.bureau_score,
           b.score_trend,
           b.has_prior_default,
           case when b.bureau_score >= 800 then 'PRIME'
                when b.bureau_score >= 650 then 'NEAR_PRIME'
                when b.bureau_score >= 500 then 'SUBPRIME'
                else 'DEEP_SUBPRIME' end as bureau_band
    from stg.stg_bureau_history as b;
quit;

/* --------------------------------------------------------------------------
   9. Interest accruals: period interest roll-up per account
   -------------------------------------------------------------------------- */

proc summary data=stg.stg_interest_accruals nway;
    class account_id;
    var accrued_interest_eur;
    output out=mart.interest_summary (drop=_type_ _freq_)
           sum=period_interest_eur
           mean=avg_daily_accrual_eur;
run;

/* --------------------------------------------------------------------------
   10. Prepayment behaviour: worst prepay band per account
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_prepayments out=work.prepay_sorted;
    by account_id descending prepay_rate;
run;

data mart.prepayment_profile;
    set work.prepay_sorted;
    by account_id;
    if first.account_id;
    keep account_id prepay_rate prepay_band redeemed_amount;
run;

/* --------------------------------------------------------------------------
   11. Securitisation flags: which accounts sit in SPV pools
   -------------------------------------------------------------------------- */

proc sql;
    create table mart.securitisation_flags as
    select s.account_id,
           s.pool_id,
           s.tranche,
           s.is_retained,
           case when s.is_retained = 1 then 'RETAINED' else 'SOLD' end
                as retention_status
    from stg.stg_securitisation_pool as s;
quit;

/* --------------------------------------------------------------------------
   12. Rating migration: notch movement per customer
   -------------------------------------------------------------------------- */

data mart.rating_migration;
    set stg.stg_rating_migrations;
    length migration_direction $10;
    if notch_change > 0 then migration_direction = 'UPGRADE';
    else if notch_change < 0 then migration_direction = 'DOWNGRADE';
    else migration_direction = 'STABLE';
    keep customer_id internal_grade notch_change migration_direction migrated;
run;

/* --------------------------------------------------------------------------
   13. Indexed LTV: restate loan-to-value on indexed collateral
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_valuation_history out=work.val_sorted; by account_id; run;

data mart.indexed_ltv;
    merge work.base_sorted (in=base keep=account_id current_balance)
          work.val_sorted  (in=val  keep=account_id indexed_value);
    by account_id;
    if base;
    if indexed_value = . or indexed_value = 0 then indexed_ltv_pct = .;
    else indexed_ltv_pct = current_balance / indexed_value * 100;
    length indexed_ltv_band $10;
    if indexed_ltv_pct = . then indexed_ltv_band = 'UNKNOWN';
    else if indexed_ltv_pct <= 60 then indexed_ltv_band = 'LE60';
    else if indexed_ltv_pct <= 80 then indexed_ltv_band = '60_80';
    else if indexed_ltv_pct <= 90 then indexed_ltv_band = '80_90';
    else indexed_ltv_band = 'GT90';
run;

/* --------------------------------------------------------------------------
   14. Insurance coverage: lapse and loss-ratio flags per account
   -------------------------------------------------------------------------- */

proc summary data=stg.stg_insurance_coverage nway;
    class account_id;
    var loss_ratio;
    output out=mart.insurance_summary (drop=_type_ _freq_)
           max=max_loss_ratio
           n=policy_count;
run;

/* --------------------------------------------------------------------------
   15. Consolidated feature mart: everything the SQL layer may need
   -------------------------------------------------------------------------- */

proc sort data=mart.mortgage_risk_features out=work.mrf_sorted; by account_id; run;
proc sort data=mart.escrow_enriched        out=work.esc2_sorted; by account_id; run;
proc sort data=mart.interest_summary       out=work.int_sorted;  by account_id; run;
proc sort data=mart.prepayment_profile     out=work.pre_sorted;  by account_id; run;
proc sort data=mart.indexed_ltv            out=work.idx_sorted;  by account_id; run;
proc sort data=mart.insurance_summary      out=work.ins_sorted;  by account_id; run;

data mart.mortgage_full_features;
    merge work.mrf_sorted (in=m)
          work.esc2_sorted (in=e keep=account_id monthly_escrow escrow_to_balance)
          work.int_sorted  (in=i keep=account_id period_interest_eur)
          work.pre_sorted  (in=p keep=account_id prepay_band prepay_rate)
          work.idx_sorted  (in=x keep=account_id indexed_ltv_pct indexed_ltv_band)
          work.ins_sorted  (in=n keep=account_id max_loss_ratio policy_count);
    by account_id;
    if m;
    if monthly_escrow = . then monthly_escrow = 0;
    if period_interest_eur = . then period_interest_eur = 0;
    if policy_count = . then policy_count = 0;
    length coverage_flag $10;
    if policy_count > 0 then coverage_flag = 'COVERED';
    else coverage_flag = 'UNCOVERED';
run;

/* --------------------------------------------------------------------------
   16. Vintage cohorts: originations grouped by year and risk stage
   -------------------------------------------------------------------------- */

data work.vintage_base;
    set mart.mortgage_full_features;
    origination_year = year(origination_date);
    keep account_id origination_year ifrs9_stage current_balance
         indexed_ltv_band coverage_flag;
run;

proc summary data=work.vintage_base nway;
    class origination_year ifrs9_stage;
    var current_balance;
    output out=mart.vintage_cohorts (drop=_type_ _freq_)
           sum=cohort_balance_eur
           n=cohort_account_count;
run;

/* --------------------------------------------------------------------------
   17. Servicing events: forbearance history joined to the feature mart
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_servicing_events out=work.svc_sorted; by account_id; run;

data mart.servicing_enriched;
    merge work.mrf_sorted (in=m keep=account_id customer_id ifrs9_stage)
          work.svc_sorted (in=s keep=account_id event_type is_forborne);
    by account_id;
    if m;
    length servicing_flag $12;
    if is_forborne = 1 then servicing_flag = 'FORBORNE';
    else servicing_flag = 'PERFORMING';
run;

/* --------------------------------------------------------------------------
   18. Hedging allocation: spread swap notionals across the mortgage book
   -------------------------------------------------------------------------- */

proc summary data=stg.stg_hedging_positions nway;
    class designation_bucket;
    var notional_eur;
    output out=mart.hedging_summary (drop=_type_ _freq_)
           sum=notional_eur
           n=swap_count;
run;

data mart.hedging_effectiveness;
    set stg.stg_hedging_positions;
    length effectiveness_band $12;
    if is_effective = 1 then effectiveness_band = 'EFFECTIVE';
    else effectiveness_band = 'INEFFECTIVE';
    keep swap_id notional_eur effectiveness_ratio effectiveness_band;
run;

/* --------------------------------------------------------------------------
   19. Discounting: attach market discount factors to the interest mart
   -------------------------------------------------------------------------- */

proc sql;
    create table mart.discounted_interest as
    select i.account_id,
           i.period_interest_eur,
           c.M3_12M as discount_factor,
           i.period_interest_eur * c.M3_12M as pv_interest_eur
    from mart.interest_summary as i
    cross join (select * from stg.stg_market_curves
                where curve_date = (select max(curve_date)
                                    from stg.stg_market_curves)) as c;
quit;

/* --------------------------------------------------------------------------
   20. Contactability: merge channel preferences onto the customer dimension
   -------------------------------------------------------------------------- */

proc sql;
    create table mart.customer_dim as
    select distinct f.customer_id,
           f.country,
           cc.marketing_opt_in,
           cc.preferred_channel
    from mart.mortgage_full_features as f
    left join stg.stg_customer_contacts as cc
           on f.customer_id = cc.customer_id;
quit;

/* --------------------------------------------------------------------------
   21. Loan term features: instalment burden and remaining-term bands
   -------------------------------------------------------------------------- */

proc sort data=stg.stg_loan_terms out=work.terms_sorted; by account_id; run;

data mart.loan_term_features;
    merge work.mrf_sorted   (in=m keep=account_id current_balance country)
          work.terms_sorted (in=t keep=account_id monthly_instalment
                             remaining_term is_interest_only);
    by account_id;
    if m;
    if monthly_instalment = . then monthly_instalment = 0;
    length term_band $10;
    if remaining_term <= 60 then term_band = 'LE5Y';
    else if remaining_term <= 180 then term_band = '5_15Y';
    else term_band = 'GT15Y';
run;

/* --------------------------------------------------------------------------
   22. Guarantee relief: guaranteed portion reduces net exposure
   -------------------------------------------------------------------------- */

proc summary data=stg.stg_guarantees nway;
    class account_id;
    var covered_amount_eur;
    output out=work.guarantee_cover (drop=_type_ _freq_)
           sum=guaranteed_eur;
run;

proc sort data=work.guarantee_cover out=work.guarantee_cover; by account_id; run;

data mart.guarantee_adjusted;
    merge work.mrf_sorted       (in=m keep=account_id country net_exposure_eur
                                 current_balance)
          work.guarantee_cover  (in=g);
    by account_id;
    if m;
    if guaranteed_eur = . then guaranteed_eur = 0;
    adjusted_exposure_eur = max(current_balance - guaranteed_eur, 0);
run;

/* --------------------------------------------------------------------------
   23. Stress results: stressed balances rolled to country / scenario
   -------------------------------------------------------------------------- */

proc summary data=stg.stg_stress_scenarios nway;
    class scenario_id;
    var stressed_balance_eur current_balance;
    output out=mart.stress_results (drop=_type_ _freq_)
           sum(stressed_balance_eur)=stressed_balance_eur
           sum(current_balance)=base_balance_eur;
run;

/* --------------------------------------------------------------------------
   24. Branch rollup: map accounts to cost centres via the branch dimension
   -------------------------------------------------------------------------- */

proc sql;
    create table mart.branch_rollup as
    select br.region_name,
           br.cost_centre,
           count(distinct f.account_id) as account_count,
           sum(f.net_exposure_eur) as net_exposure_eur
    from mart.mortgage_full_features as f
    left join stg.stg_branch_reference as br
           on f.branch_id = br.branch_id
    group by br.region_name, br.cost_centre;
quit;
