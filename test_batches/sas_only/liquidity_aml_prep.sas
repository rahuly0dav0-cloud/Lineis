/* ============================================================================
   LIQUIDITY & AML REGULATORY DATA PREPARATION  (SAS-only test batch)
   Scope: LCR / NSFR liquidity metrics plus AML transaction monitoring feeds.
   Deliberately "tricky": LIBNAME aliases, multi-dataset SET, MERGE with BY,
   PROC SQL create-table, PROC SUMMARY / MEANS / SORT / TRANSPOSE with OUT=,
   nested work datasets, and a final regulatory mart consumed downstream.
   Flow:  raw  ->  work staging  ->  mart enrichment  ->  reg outputs
   ============================================================================ */

libname raw   "/data/raw";
libname work2 "/data/work";
libname mart  "/data/mart";
libname reg   "/data/regulatory";

/* --------------------------------------------------------------------------
   1. STAGING : pull and clean the raw core-banking and market extracts
   -------------------------------------------------------------------------- */

data work2.stg_accounts;
    set raw.core_accounts (where=(account_status in ('ACTIVE', 'DORMANT')));
    length product_group $20;
    if product_code in ('CA01', 'CA02', 'CA03') then product_group = 'CURRENT';
    else if product_code in ('SV01', 'SV02')    then product_group = 'SAVINGS';
    else if product_code in ('TD01', 'TD02')    then product_group = 'TERM_DEPOSIT';
    else if product_code like 'LN%'             then product_group = 'LOAN';
    else product_group = 'OTHER';
    keep account_id customer_id product_code product_group currency_code
         open_date account_status branch_id credit_limit;
run;

data work2.stg_balances;
    set raw.core_balances;
    where as_of_date = "&snap_date"d;
    if available_balance = . then available_balance = ledger_balance;
    keep account_id as_of_date ledger_balance available_balance
         accrued_interest currency_code;
run;

data work2.stg_customers;
    set raw.core_customers (where=(record_status ne 'DELETED'));
    length segment $15;
    country_code = upcase(country_code);
    if customer_segment = 'R' then segment = 'RETAIL';
    else if customer_segment = 'P' then segment = 'PRIVATE';
    else if customer_segment = 'B' then segment = 'BUSINESS';
    else segment = 'CORPORATE';
    keep customer_id legal_name country_code segment customer_type
         kyc_status onboarding_date risk_rating_internal;
run;

data work2.stg_transactions;
    set raw.core_transactions (where=(posting_date >= "01JAN2023"d));
    length flow_direction $6;
    if amount >= 0 then flow_direction = 'IN';
    else flow_direction = 'OUT';
    abs_amount = abs(amount);
    keep transaction_id account_id posting_date value_date amount abs_amount
         flow_direction currency_code transaction_type counterparty_id channel;
run;

data work2.stg_fx;
    set raw.market_fx_rates;
    where rate_date = "&snap_date"d;
    keep currency_code rate_date rate_to_eur;
run;

data work2.stg_hqla;
    set raw.market_hqla_securities;
    length hqla_level $6;
    if asset_class in ('SOVEREIGN', 'CASH', 'CENTRAL_BANK') then hqla_level = 'L1';
    else if asset_class in ('COVERED_BOND', 'CORP_AA')      then hqla_level = 'L2A';
    else if asset_class in ('CORP_A', 'EQUITY_MAIN')        then hqla_level = 'L2B';
    else hqla_level = 'NONE';
    keep security_id asset_class market_value_eur hqla_level haircut_pct;
run;

/* --------------------------------------------------------------------------
   2. FX CONVERSION : merge balances and transactions with the FX snapshot
   -------------------------------------------------------------------------- */

proc sort data=work2.stg_balances     out=work2.bal_sorted;  by currency_code; run;
proc sort data=work2.stg_fx           out=work2.fx_sorted;   by currency_code; run;
proc sort data=work2.stg_transactions out=work2.txn_sorted;  by currency_code; run;

/* Balances converted to EUR via a MERGE on currency_code. */
data work2.balances_eur;
    merge work2.bal_sorted (in=b)
          work2.fx_sorted  (in=f keep=currency_code rate_to_eur);
    by currency_code;
    if b;
    if rate_to_eur = . then rate_to_eur = 1;
    ledger_balance_eur    = ledger_balance    * rate_to_eur;
    available_balance_eur = available_balance * rate_to_eur;
run;

/* Transactions converted to EUR via a MERGE on currency_code. */
data work2.transactions_eur;
    merge work2.txn_sorted (in=t)
          work2.fx_sorted  (in=f keep=currency_code rate_to_eur);
    by currency_code;
    if t;
    if rate_to_eur = . then rate_to_eur = 1;
    amount_eur     = amount     * rate_to_eur;
    abs_amount_eur = abs_amount * rate_to_eur;
run;

/* --------------------------------------------------------------------------
   3. ACCOUNT ENRICHMENT : combine accounts, customers and balances
   -------------------------------------------------------------------------- */

proc sort data=work2.stg_accounts  out=work2.acc_sorted;  by customer_id; run;
proc sort data=work2.stg_customers out=work2.cust_sorted; by customer_id; run;

/* Accounts enriched with customer attributes. */
data work2.account_customer;
    merge work2.acc_sorted  (in=a)
          work2.cust_sorted (in=c);
    by customer_id;
    if a and c;
run;

proc sort data=work2.account_customer out=work2.account_customer;
    by account_id;
run;
proc sort data=work2.balances_eur out=work2.balances_eur;
    by account_id;
run;

/* Account base = account + customer + EUR balance. */
data mart.account_base;
    merge work2.account_customer (in=a)
          work2.balances_eur     (in=b keep=account_id ledger_balance_eur
                                   available_balance_eur accrued_interest);
    by account_id;
    if a;
    if ledger_balance_eur = . then ledger_balance_eur = 0;
run;

/* --------------------------------------------------------------------------
   4. TRANSACTION AGGREGATES : PROC SUMMARY / MEANS with OUT=
   -------------------------------------------------------------------------- */

/* Monthly in/out flow per account. */
proc summary data=work2.transactions_eur nway;
    class account_id flow_direction;
    var amount_eur abs_amount_eur;
    output out=work2.flow_summary (drop=_type_ _freq_)
           sum(amount_eur)=net_flow_eur
           sum(abs_amount_eur)=gross_flow_eur;
run;

/* Transpose the in/out flows into one row per account. */
proc transpose data=work2.flow_summary
               out=mart.account_flows (drop=_name_)
               prefix=flow_;
    by account_id;
    id flow_direction;
    var net_flow_eur;
run;

/* High level transaction statistics per account. */
proc means data=work2.transactions_eur noprint nway;
    class account_id;
    var amount_eur;
    output out=work2.txn_stats (drop=_type_ _freq_)
           n=txn_count
           sum=total_amount_eur
           mean=avg_amount_eur
           max=max_amount_eur;
run;

/* --------------------------------------------------------------------------
   5. AML MONITORING : suspicious-activity candidate feed via PROC SQL
   -------------------------------------------------------------------------- */

proc sql;
    /* Large single transactions over threshold. */
    create table work2.aml_large_txn as
    select t.account_id,
           t.transaction_id,
           t.posting_date,
           t.amount_eur,
           t.counterparty_id,
           t.channel
    from work2.transactions_eur as t
    where t.abs_amount_eur >= 10000;

    /* Rapid movement: many transactions in a short window per account. */
    create table work2.aml_velocity as
    select account_id,
           count(*)            as txn_30d,
           sum(abs_amount_eur) as volume_30d_eur
    from work2.transactions_eur
    group by account_id
    having calculated txn_30d >= 25;

    /* Cross-border counterparties for monitored customers. */
    create table mart.aml_candidates as
    select l.account_id,
           l.transaction_id,
           l.posting_date,
           l.amount_eur,
           l.counterparty_id,
           v.txn_30d,
           v.volume_30d_eur,
           ac.customer_id,
           ac.country_code,
           ac.segment
    from work2.aml_large_txn as l
    inner join work2.aml_velocity as v
            on l.account_id = v.account_id
    left join work2.account_customer as ac
            on l.account_id = ac.account_id;
quit;

/* --------------------------------------------------------------------------
   6. LIQUIDITY : HQLA buffer, outflows, inflows, LCR and NSFR
   -------------------------------------------------------------------------- */

/* HQLA buffer after applying regulatory haircuts, by level. */
proc sql;
    create table work2.hqla_buffer as
    select hqla_level,
           sum(market_value_eur * (1 - haircut_pct / 100)) as weighted_hqla_eur
    from work2.stg_hqla
    where hqla_level ne 'NONE'
    group by hqla_level;

    create table mart.hqla_total as
    select sum(weighted_hqla_eur) as total_hqla_eur
    from work2.hqla_buffer;
quit;

/* Expected 30-day outflows: a run-off fraction of deposit balances. */
data work2.outflows;
    set mart.account_base;
    length outflow_category $20;
    if product_group = 'CURRENT'      then runoff_rate = 0.10;
    else if product_group = 'SAVINGS' then runoff_rate = 0.05;
    else if product_group = 'TERM_DEPOSIT' then runoff_rate = 0.03;
    else runoff_rate = 0.15;
    stressed_outflow_eur = ledger_balance_eur * runoff_rate;
    if product_group in ('CURRENT','SAVINGS','TERM_DEPOSIT')
        then outflow_category = 'DEPOSIT';
    else outflow_category = 'OTHER';
    keep account_id customer_id country_code product_group outflow_category
         ledger_balance_eur runoff_rate stressed_outflow_eur;
run;

proc summary data=work2.outflows nway;
    class country_code;
    var stressed_outflow_eur ledger_balance_eur;
    output out=work2.outflow_by_country (drop=_type_ _freq_)
           sum(stressed_outflow_eur)=total_outflow_eur
           sum(ledger_balance_eur)=total_deposits_eur;
run;

/* Expected 30-day inflows from performing loan accounts. */
data work2.inflows;
    set mart.account_base (where=(product_group = 'LOAN'));
    inflow_eur = max(ledger_balance_eur, 0) * 0.50;
    keep account_id customer_id country_code inflow_eur;
run;

proc summary data=work2.inflows nway;
    class country_code;
    var inflow_eur;
    output out=work2.inflow_by_country (drop=_type_ _freq_)
           sum(inflow_eur)=total_inflow_eur;
run;

/* Combine outflows and inflows into a net liquidity position per country. */
proc sort data=work2.outflow_by_country out=work2.outflow_by_country;
    by country_code;
run;
proc sort data=work2.inflow_by_country out=work2.inflow_by_country;
    by country_code;
run;

data mart.liquidity_position;
    merge work2.outflow_by_country (in=o)
          work2.inflow_by_country  (in=i);
    by country_code;
    if total_inflow_eur = . then total_inflow_eur = 0;
    /* Inflows capped at 75% of outflows per the LCR rules. */
    capped_inflow_eur = min(total_inflow_eur, 0.75 * total_outflow_eur);
    net_outflow_eur   = total_outflow_eur - capped_inflow_eur;
run;

/* --------------------------------------------------------------------------
   7. REG OUTPUTS : the final regulatory datasets consumed downstream
   -------------------------------------------------------------------------- */

/* LCR = HQLA buffer / net 30-day outflows. Cross join to the single HQLA total. */
proc sql;
    create table reg.lcr_report as
    select lp.country_code,
           lp.total_outflow_eur,
           lp.capped_inflow_eur,
           lp.net_outflow_eur,
           h.total_hqla_eur,
           case when lp.net_outflow_eur > 0
                then h.total_hqla_eur / lp.net_outflow_eur
                else . end as lcr_ratio
    from mart.liquidity_position as lp
    cross join mart.hqla_total as h;
quit;

/* NSFR proxy: stable funding vs required funding by country. */
proc sql;
    create table reg.nsfr_report as
    select ab.country_code,
           sum(ab.ledger_balance_eur) as available_stable_funding_eur,
           sum(ab.ledger_balance_eur * 0.65) as required_stable_funding_eur
    from mart.account_base as ab
    group by ab.country_code;
quit;

/* AML regulatory submission feed built from the candidate list + stats. */
proc sort data=mart.aml_candidates out=work2.aml_sorted; by account_id; run;
proc sort data=work2.txn_stats      out=work2.stats_sorted; by account_id; run;

data reg.aml_submission;
    merge work2.aml_sorted   (in=a)
          work2.stats_sorted (in=s keep=account_id txn_count total_amount_eur);
    by account_id;
    if a;
    submission_date = today();
    format submission_date date9.;
run;

/* Consolidated liquidity + AML supervisory pack (final artefact). */
proc sql;
    create table reg.supervisory_pack as
    select l.country_code,
           l.lcr_ratio,
           n.available_stable_funding_eur,
           n.required_stable_funding_eur,
           case when n.required_stable_funding_eur > 0
                then n.available_stable_funding_eur / n.required_stable_funding_eur
                else . end as nsfr_ratio,
           count(distinct a.account_id) as aml_flagged_accounts
    from reg.lcr_report as l
    left join reg.nsfr_report as n
           on l.country_code = n.country_code
    left join reg.aml_submission as a
           on l.country_code = a.country_code
    group by l.country_code, l.lcr_ratio,
             n.available_stable_funding_eur, n.required_stable_funding_eur;
quit;

/* --------------------------------------------------------------------------
   8. ASSET ENCUMBRANCE : collateral pledged vs available for secured funding
   -------------------------------------------------------------------------- */

data work2.stg_collateral;
    set raw.core_collateral (where=(valuation_amount > 0));
    length encumbrance_flag $12;
    if pledged_flag = 'Y' then encumbrance_flag = 'ENCUMBERED';
    else encumbrance_flag = 'UNENCUMBERED';
    keep collateral_id account_id collateral_type valuation_amount
         haircut_pct currency_code encumbrance_flag;
run;

proc sort data=work2.stg_collateral out=work2.col_sorted; by currency_code; run;

/* Convert collateral valuations to EUR via the FX snapshot. */
data work2.collateral_eur;
    merge work2.col_sorted (in=c)
          work2.fx_sorted  (in=f keep=currency_code rate_to_eur);
    by currency_code;
    if c;
    if rate_to_eur = . then rate_to_eur = 1;
    value_eur       = valuation_amount * rate_to_eur;
    eligible_eur    = valuation_amount * (1 - haircut_pct / 100) * rate_to_eur;
run;

/* Encumbrance ratio per account joined back to the account base. */
proc summary data=work2.collateral_eur nway;
    class account_id encumbrance_flag;
    var value_eur eligible_eur;
    output out=work2.encumbrance_by_acc (drop=_type_ _freq_)
           sum(value_eur)=value_eur
           sum(eligible_eur)=eligible_eur;
run;

proc transpose data=work2.encumbrance_by_acc
               out=work2.encumbrance_wide (drop=_name_)
               prefix=enc_;
    by account_id;
    id encumbrance_flag;
    var value_eur;
run;

proc sort data=work2.encumbrance_wide out=work2.encumbrance_wide;
    by account_id;
run;

data mart.asset_encumbrance;
    merge mart.account_base       (in=a keep=account_id customer_id country_code
                                   product_group ledger_balance_eur)
          work2.encumbrance_wide  (in=e);
    by account_id;
    if a;
    if enc_ENCUMBERED   = . then enc_ENCUMBERED = 0;
    if enc_UNENCUMBERED = . then enc_UNENCUMBERED = 0;
    total_collateral_eur = enc_ENCUMBERED + enc_UNENCUMBERED;
    if total_collateral_eur > 0
        then encumbrance_ratio = enc_ENCUMBERED / total_collateral_eur;
        else encumbrance_ratio = 0;
run;

proc summary data=mart.asset_encumbrance nway;
    class country_code;
    var enc_ENCUMBERED enc_UNENCUMBERED total_collateral_eur;
    output out=reg.encumbrance_report (drop=_type_ _freq_)
           sum(enc_ENCUMBERED)=encumbered_eur
           sum(enc_UNENCUMBERED)=unencumbered_eur
           sum(total_collateral_eur)=total_collateral_eur;
run;

/* --------------------------------------------------------------------------
   9. IRRBB : interest-rate repricing gap in the banking book
   -------------------------------------------------------------------------- */

/* Assign each account to a repricing time bucket. */
data work2.repricing;
    set mart.account_base;
    length bucket $12;
    months_to_reprice = intck('month', open_date, "&snap_date"d);
    if months_to_reprice <= 3        then bucket = 'LE_3M';
    else if months_to_reprice <= 12  then bucket = 'M3_12M';
    else if months_to_reprice <= 60  then bucket = 'Y1_5Y';
    else bucket = 'GT_5Y';
    /* Assets positive, deposit-style liabilities negative. */
    if product_group = 'LOAN'
        then gap_eur = ledger_balance_eur;
        else gap_eur = -1 * ledger_balance_eur;
    keep account_id country_code bucket gap_eur ledger_balance_eur;
run;

proc summary data=work2.repricing nway;
    class country_code bucket;
    var gap_eur;
    output out=work2.gap_by_bucket (drop=_type_ _freq_)
           sum(gap_eur)=net_gap_eur;
run;

proc transpose data=work2.gap_by_bucket
               out=mart.irrbb_gap (drop=_name_)
               prefix=gap_;
    by country_code;
    id bucket;
    var net_gap_eur;
run;

/* Apply standardised rate-shock weights and sum to an EVE delta. */
data reg.irrbb_report;
    set mart.irrbb_gap;
    if gap_LE_3M  = . then gap_LE_3M = 0;
    if gap_M3_12M = . then gap_M3_12M = 0;
    if gap_Y1_5Y  = . then gap_Y1_5Y = 0;
    if gap_GT_5Y  = . then gap_GT_5Y = 0;
    /* +200bp parallel shock, longer buckets carry more duration risk. */
    delta_eve_eur = gap_LE_3M  * 0.001
                  + gap_M3_12M * 0.008
                  + gap_Y1_5Y  * 0.030
                  + gap_GT_5Y  * 0.070;
run;

/* --------------------------------------------------------------------------
   10. FINAL BOARD PACK : liquidity + encumbrance + IRRBB in one artefact
   -------------------------------------------------------------------------- */

proc sql;
    create table reg.board_liquidity_pack as
    select s.country_code,
           s.lcr_ratio,
           s.nsfr_ratio,
           s.aml_flagged_accounts,
           e.encumbered_eur,
           e.unencumbered_eur,
           case when (e.encumbered_eur + e.unencumbered_eur) > 0
                then e.encumbered_eur / (e.encumbered_eur + e.unencumbered_eur)
                else . end as encumbrance_ratio,
           r.delta_eve_eur
    from reg.supervisory_pack as s
    left join reg.encumbrance_report as e
           on s.country_code = e.country_code
    left join reg.irrbb_report as r
           on s.country_code = r.country_code;
quit;

/* --------------------------------------------------------------------------
   11. FUNDING CONCENTRATION : reliance on the largest depositors (ALMM C 67)
   -------------------------------------------------------------------------- */

/* Deposit balances rolled up to the customer level. */
proc summary data=mart.account_base nway;
    class customer_id country_code;
    var ledger_balance_eur;
    output out=work2.depositor_totals (drop=_type_ _freq_)
           sum(ledger_balance_eur)=deposit_eur;
run;

/* Rank depositors within each country by size. */
proc sort data=work2.depositor_totals out=work2.depositor_ranked;
    by country_code descending deposit_eur;
run;

data work2.top_depositors;
    set work2.depositor_ranked;
    by country_code descending deposit_eur;
    if first.country_code then rank = 0;
    rank + 1;
    retain rank;
    if rank <= 10;
run;

proc summary data=work2.top_depositors nway;
    class country_code;
    var deposit_eur;
    output out=reg.funding_concentration (drop=_type_ _freq_)
           sum(deposit_eur)=top10_deposit_eur
           n(deposit_eur)=top10_count;
run;
