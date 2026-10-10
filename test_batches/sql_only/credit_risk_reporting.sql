-- ============================================================================
--  CREDIT RISK & REGULATORY REPORTING PIPELINE  (SQL-only test batch)
--  Scope: FINREP / COREP / IFRS9 ECL for a multi-country retail bank.
--  Deliberately "tricky": CTEs, window functions, UNION ALL, self-joins,
--  nested sub-queries, temp/intermediate tables across several schemas, and
--  a final set of regulatory views. Designed to stress table-level lineage.
--  Schemas:  raw -> stg -> enrich -> risk -> reg
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. STAGING : clean and standardise the raw core-banking extracts
-- ----------------------------------------------------------------------------

CREATE TABLE stg.customers AS
SELECT
    c.customer_id,
    UPPER(TRIM(c.legal_name))                         AS legal_name,
    UPPER(c.country_code)                             AS country_code,
    c.customer_segment,
    c.date_of_birth,
    c.incorporation_date,
    CASE WHEN c.customer_type = 'I' THEN 'INDIVIDUAL'
         WHEN c.customer_type = 'C' THEN 'CORPORATE'
         ELSE 'OTHER' END                             AS customer_type,
    c.kyc_status,
    c.onboarding_date,
    c.risk_rating_internal
FROM raw.core_customers c
WHERE c.record_status <> 'DELETED';

CREATE TABLE stg.accounts AS
SELECT
    a.account_id,
    a.customer_id,
    a.product_code,
    a.currency_code,
    a.open_date,
    a.close_date,
    a.account_status,
    a.branch_id,
    COALESCE(a.credit_limit, 0)                       AS credit_limit
FROM raw.core_accounts a
WHERE a.customer_id IS NOT NULL;

CREATE TABLE stg.balances AS
SELECT
    b.account_id,
    b.as_of_date,
    b.ledger_balance,
    b.available_balance,
    b.currency_code,
    b.accrued_interest
FROM raw.core_balances b
WHERE b.as_of_date = (SELECT MAX(as_of_date) FROM raw.core_balances);

CREATE TABLE stg.transactions AS
SELECT
    t.transaction_id,
    t.account_id,
    t.posting_date,
    t.value_date,
    t.amount,
    t.currency_code,
    t.transaction_type,
    t.counterparty_id,
    t.channel
FROM raw.core_transactions t
WHERE t.posting_date >= DATE '2023-01-01';

CREATE TABLE stg.collateral AS
SELECT
    col.collateral_id,
    col.account_id,
    col.collateral_type,
    col.valuation_amount,
    col.valuation_date,
    col.haircut_pct,
    col.currency_code
FROM raw.core_collateral col
WHERE col.valuation_amount > 0;

CREATE TABLE stg.fx_rates AS
SELECT
    fx.currency_code,
    fx.rate_date,
    fx.rate_to_eur
FROM raw.market_fx_rates fx
WHERE fx.rate_date = (SELECT MAX(rate_date) FROM raw.market_fx_rates);

CREATE TABLE stg.ratings AS
SELECT
    r.counterparty_id,
    r.agency,
    r.rating_grade,
    r.rating_date,
    r.pd_estimate
FROM raw.market_ratings r;

-- ----------------------------------------------------------------------------
-- 2. ENRICHMENT : convert to EUR, derive customer & account level features
-- ----------------------------------------------------------------------------

-- Balances converted to EUR via the latest FX snapshot.
CREATE TABLE enrich.balances_eur AS
SELECT
    b.account_id,
    b.as_of_date,
    b.ledger_balance,
    b.available_balance,
    b.accrued_interest,
    b.currency_code,
    fx.rate_to_eur,
    b.ledger_balance    * fx.rate_to_eur              AS ledger_balance_eur,
    b.available_balance * fx.rate_to_eur              AS available_balance_eur
FROM stg.balances b
LEFT JOIN stg.fx_rates fx
       ON b.currency_code = fx.currency_code;

-- Transaction activity aggregated to account level using window + group by.
CREATE TABLE enrich.account_activity AS
WITH txn_eur AS (
    SELECT
        t.account_id,
        t.transaction_id,
        t.posting_date,
        t.transaction_type,
        t.amount * fx.rate_to_eur                     AS amount_eur
    FROM stg.transactions t
    LEFT JOIN stg.fx_rates fx
           ON t.currency_code = fx.currency_code
),
ranked AS (
    SELECT
        account_id,
        transaction_id,
        posting_date,
        amount_eur,
        ROW_NUMBER() OVER (PARTITION BY account_id
                           ORDER BY posting_date DESC) AS rn,
        SUM(amount_eur) OVER (PARTITION BY account_id) AS lifetime_amount_eur
    FROM txn_eur
)
SELECT
    account_id,
    COUNT(*)                                          AS txn_count,
    SUM(amount_eur)                                   AS total_amount_eur,
    AVG(amount_eur)                                   AS avg_amount_eur,
    MAX(CASE WHEN rn = 1 THEN posting_date END)       AS last_txn_date,
    MAX(lifetime_amount_eur)                          AS lifetime_amount_eur
FROM ranked
GROUP BY account_id;

-- Collateral netted of haircut and converted to EUR.
CREATE TABLE enrich.collateral_eur AS
SELECT
    col.account_id,
    SUM(col.valuation_amount * (1 - col.haircut_pct / 100.0) * fx.rate_to_eur)
                                                      AS eligible_collateral_eur,
    COUNT(*)                                          AS collateral_count
FROM stg.collateral col
LEFT JOIN stg.fx_rates fx
       ON col.currency_code = fx.currency_code
GROUP BY col.account_id;

-- Customer master enriched with account counts and segments.
CREATE TABLE enrich.customer_master AS
SELECT
    c.customer_id,
    c.legal_name,
    c.country_code,
    c.customer_type,
    c.customer_segment,
    c.risk_rating_internal,
    c.kyc_status,
    COUNT(DISTINCT a.account_id)                      AS account_count,
    MIN(a.open_date)                                  AS first_account_date
FROM stg.customers c
LEFT JOIN stg.accounts a
       ON c.customer_id = a.customer_id
GROUP BY
    c.customer_id, c.legal_name, c.country_code, c.customer_type,
    c.customer_segment, c.risk_rating_internal, c.kyc_status;

-- Account-level base table joining accounts, balances, activity and collateral.
CREATE TABLE enrich.account_base AS
SELECT
    a.account_id,
    a.customer_id,
    a.product_code,
    a.currency_code,
    a.account_status,
    a.credit_limit,
    be.ledger_balance_eur,
    be.available_balance_eur,
    be.accrued_interest,
    aa.txn_count,
    aa.total_amount_eur,
    aa.last_txn_date,
    ce.eligible_collateral_eur
FROM stg.accounts a
LEFT JOIN enrich.balances_eur     be ON a.account_id = be.account_id
LEFT JOIN enrich.account_activity aa ON a.account_id = aa.account_id
LEFT JOIN enrich.collateral_eur   ce ON a.account_id = ce.account_id;

-- ----------------------------------------------------------------------------
-- 3. RISK : exposure, PD/LGD, IFRS9 staging and expected credit loss
-- ----------------------------------------------------------------------------

-- Exposure at default = drawn balance + a fraction of undrawn commitment.
CREATE TABLE risk.exposure AS
SELECT
    ab.account_id,
    ab.customer_id,
    cm.country_code,
    cm.customer_type,
    GREATEST(ab.ledger_balance_eur, 0)                AS drawn_eur,
    GREATEST(ab.credit_limit - ab.ledger_balance_eur, 0) AS undrawn_eur,
    GREATEST(ab.ledger_balance_eur, 0)
        + 0.40 * GREATEST(ab.credit_limit - ab.ledger_balance_eur, 0)
                                                      AS ead_eur,
    COALESCE(ab.eligible_collateral_eur, 0)           AS collateral_eur
FROM enrich.account_base ab
JOIN enrich.customer_master cm
      ON ab.customer_id = cm.customer_id;

-- Probability of default: blend internal rating with agency PD where available.
CREATE TABLE risk.pd_lgd AS
WITH agency_pd AS (
    SELECT
        a.customer_id,
        AVG(rt.pd_estimate)                           AS agency_pd
    FROM stg.accounts a
    JOIN stg.transactions t ON a.account_id = t.account_id
    JOIN stg.ratings      rt ON t.counterparty_id = rt.counterparty_id
    GROUP BY a.customer_id
)
SELECT
    cm.customer_id,
    cm.country_code,
    COALESCE(ap.agency_pd,
             CASE cm.risk_rating_internal
                  WHEN 1 THEN 0.002 WHEN 2 THEN 0.005
                  WHEN 3 THEN 0.010 WHEN 4 THEN 0.025
                  WHEN 5 THEN 0.060 ELSE 0.120 END)   AS pd,
    CASE WHEN cm.customer_type = 'CORPORATE' THEN 0.45
         ELSE 0.35 END                                AS lgd
FROM enrich.customer_master cm
LEFT JOIN agency_pd ap
       ON cm.customer_id = ap.customer_id;

-- IFRS9 staging based on simple days-past-due / activity proxy.
CREATE TABLE risk.ifrs9_staging AS
SELECT
    e.account_id,
    e.customer_id,
    e.ead_eur,
    pl.pd,
    pl.lgd,
    CASE
        WHEN e.ead_eur = 0                     THEN 'STAGE_0'
        WHEN pl.pd >= 0.10                      THEN 'STAGE_3'
        WHEN pl.pd >= 0.03                      THEN 'STAGE_2'
        ELSE 'STAGE_1'
    END                                               AS ifrs9_stage
FROM risk.exposure e
JOIN risk.pd_lgd pl
      ON e.customer_id = pl.customer_id;

-- Expected credit loss = EAD net of collateral * PD * LGD, stage-adjusted.
CREATE TABLE risk.ecl AS
SELECT
    s.account_id,
    s.customer_id,
    e.country_code,
    s.ifrs9_stage,
    e.ead_eur,
    e.collateral_eur,
    GREATEST(e.ead_eur - e.collateral_eur, 0)         AS net_exposure_eur,
    s.pd,
    s.lgd,
    CASE s.ifrs9_stage
         WHEN 'STAGE_1' THEN GREATEST(e.ead_eur - e.collateral_eur, 0) * s.pd * s.lgd
         WHEN 'STAGE_2' THEN GREATEST(e.ead_eur - e.collateral_eur, 0) * s.pd * s.lgd * 3
         WHEN 'STAGE_3' THEN GREATEST(e.ead_eur - e.collateral_eur, 0) * s.lgd
         ELSE 0
    END                                               AS ecl_eur
FROM risk.ifrs9_staging s
JOIN risk.exposure e
      ON s.account_id = e.account_id;

-- Risk-weighted assets under a simplified standardised approach.
CREATE TABLE risk.rwa AS
SELECT
    ecl.account_id,
    ecl.customer_id,
    ecl.country_code,
    ecl.net_exposure_eur,
    CASE
        WHEN ecl.ifrs9_stage = 'STAGE_3' THEN ecl.net_exposure_eur * 1.50
        WHEN ecl.pd >= 0.06              THEN ecl.net_exposure_eur * 1.00
        WHEN ecl.pd >= 0.01              THEN ecl.net_exposure_eur * 0.75
        ELSE ecl.net_exposure_eur * 0.35
    END                                               AS rwa_eur
FROM risk.ecl ecl;

-- ----------------------------------------------------------------------------
-- 4. REG : FINREP / COREP aggregates + incremental board feed (INSERT)
-- ----------------------------------------------------------------------------

-- FINREP F 04.00 : carrying amounts by country and stage.
CREATE TABLE reg.finrep_f0400 AS
SELECT
    e.country_code,
    s.ifrs9_stage,
    COUNT(*)                                          AS exposure_count,
    SUM(e.ead_eur)                                    AS gross_carrying_eur,
    SUM(e.collateral_eur)                             AS collateral_eur
FROM risk.exposure e
JOIN risk.ifrs9_staging s
      ON e.account_id = s.account_id
GROUP BY e.country_code, s.ifrs9_stage;

-- FINREP F 12.00 : impairment (ECL) by country and stage.
CREATE TABLE reg.finrep_f1200 AS
SELECT
    country_code,
    ifrs9_stage,
    SUM(ecl_eur)                                      AS impairment_eur,
    SUM(net_exposure_eur)                             AS net_exposure_eur
FROM risk.ecl
GROUP BY country_code, ifrs9_stage;

-- COREP C 07.00 : credit risk RWA by country.
CREATE TABLE reg.corep_c0700 AS
SELECT
    country_code,
    SUM(net_exposure_eur)                             AS net_exposure_eur,
    SUM(rwa_eur)                                      AS rwa_eur,
    SUM(rwa_eur) * 0.08                               AS capital_requirement_eur
FROM risk.rwa
GROUP BY country_code;

-- Consolidated group totals via UNION ALL of the two FINREP tables.
CREATE TABLE reg.finrep_consolidated AS
SELECT country_code, ifrs9_stage, gross_carrying_eur AS amount_eur,
       'CARRYING' AS measure
FROM reg.finrep_f0400
UNION ALL
SELECT country_code, ifrs9_stage, impairment_eur AS amount_eur,
       'IMPAIRMENT' AS measure
FROM reg.finrep_f1200;

-- Incremental load into the historical board feed (INSERT ... SELECT).
INSERT INTO reg.board_feed_history
SELECT
    c.country_code,
    c.net_exposure_eur,
    c.rwa_eur,
    c.capital_requirement_eur,
    CURRENT_DATE                                      AS snapshot_date
FROM reg.corep_c0700 c;

-- ----------------------------------------------------------------------------
-- 5. REG VIEWS : the artefacts consumed by the board and supervisors
-- ----------------------------------------------------------------------------

CREATE VIEW reg.v_capital_adequacy AS
SELECT
    c.country_code,
    c.net_exposure_eur,
    c.rwa_eur,
    c.capital_requirement_eur,
    f.impairment_eur,
    c.capital_requirement_eur + f.impairment_eur      AS total_absorbing_eur
FROM reg.corep_c0700 c
LEFT JOIN (
    SELECT country_code, SUM(impairment_eur) AS impairment_eur
    FROM reg.finrep_f1200
    GROUP BY country_code
) f ON c.country_code = f.country_code;

CREATE VIEW reg.v_board_risk_summary AS
SELECT
    ca.country_code,
    ca.net_exposure_eur,
    ca.rwa_eur,
    ca.capital_requirement_eur,
    ca.total_absorbing_eur,
    cons.amount_eur                                   AS consolidated_amount_eur
FROM reg.v_capital_adequacy ca
LEFT JOIN (
    SELECT country_code, SUM(amount_eur) AS amount_eur
    FROM reg.finrep_consolidated
    GROUP BY country_code
) cons ON ca.country_code = cons.country_code;

-- Final single artefact that a board member would actually open.
CREATE VIEW reg.v_group_regulatory_dashboard AS
SELECT
    s.country_code,
    s.net_exposure_eur,
    s.rwa_eur,
    s.capital_requirement_eur,
    s.total_absorbing_eur,
    s.consolidated_amount_eur,
    ROUND(s.capital_requirement_eur
          / NULLIF(s.net_exposure_eur, 0) * 100, 2)   AS capital_ratio_pct
FROM reg.v_board_risk_summary s;

-- ----------------------------------------------------------------------------
-- 6. LARGE EXPOSURES & CONCENTRATION  (COREP C 28.00 / C 29.00)
--    Groups of connected clients, 10%-of-capital breach flags, top-N ranking.
-- ----------------------------------------------------------------------------

-- Connected-client groups: roll individual accounts up to the ultimate parent.
CREATE TABLE stg.connected_groups AS
SELECT
    g.customer_id,
    g.ultimate_parent_id,
    g.group_name,
    g.connection_type
FROM raw.ref_connected_groups g
WHERE g.connection_type IN ('CONTROL', 'ECONOMIC');

-- Exposure rolled up to the connected group (falls back to the customer itself).
CREATE TABLE risk.group_exposure AS
WITH mapped AS (
    SELECT
        e.account_id,
        e.customer_id,
        COALESCE(cg.ultimate_parent_id, e.customer_id) AS group_id,
        COALESCE(cg.group_name, 'STANDALONE')          AS group_name,
        e.ead_eur,
        e.collateral_eur
    FROM risk.exposure e
    LEFT JOIN stg.connected_groups cg
           ON e.customer_id = cg.customer_id
)
SELECT
    group_id,
    MAX(group_name)                                    AS group_name,
    COUNT(DISTINCT customer_id)                         AS client_count,
    COUNT(DISTINCT account_id)                          AS account_count,
    SUM(ead_eur)                                        AS group_ead_eur,
    SUM(GREATEST(ead_eur - collateral_eur, 0))          AS group_net_eur
FROM mapped
GROUP BY group_id;

-- Own funds snapshot used as the large-exposure denominator.
CREATE TABLE risk.own_funds AS
SELECT
    o.reporting_date,
    o.tier1_capital_eur,
    o.tier2_capital_eur,
    o.tier1_capital_eur + o.tier2_capital_eur           AS total_own_funds_eur
FROM raw.fin_own_funds o
WHERE o.reporting_date = (SELECT MAX(reporting_date) FROM raw.fin_own_funds);

-- COREP C 28.00 : large exposures with the 10%-of-own-funds breach flag.
CREATE TABLE reg.corep_c2800 AS
SELECT
    ge.group_id,
    ge.group_name,
    ge.client_count,
    ge.group_net_eur,
    of.total_own_funds_eur,
    ROUND(ge.group_net_eur
          / NULLIF(of.total_own_funds_eur, 0) * 100, 2) AS pct_of_own_funds,
    CASE WHEN ge.group_net_eur >= 0.10 * of.total_own_funds_eur
         THEN 'LARGE_EXPOSURE' ELSE 'NORMAL' END         AS exposure_class
FROM risk.group_exposure ge
CROSS JOIN risk.own_funds of;

-- Top-20 concentration ranking via a window function over the large exposures.
CREATE TABLE reg.corep_c2900 AS
WITH ranked AS (
    SELECT
        c.group_id,
        c.group_name,
        c.group_net_eur,
        c.pct_of_own_funds,
        c.exposure_class,
        RANK() OVER (ORDER BY c.group_net_eur DESC)     AS concentration_rank
    FROM reg.corep_c2800 c
)
SELECT *
FROM ranked
WHERE concentration_rank <= 20;

-- ----------------------------------------------------------------------------
-- 7. LIQUIDITY  (COREP C 72.00 / C 73.00 : LCR inflows and outflows)
-- ----------------------------------------------------------------------------

-- High-quality liquid assets, haircut by HQLA level.
CREATE TABLE risk.hqla AS
SELECT
    h.asset_id,
    h.hqla_level,
    h.market_value_eur,
    CASE h.hqla_level
         WHEN 'L1'  THEN h.market_value_eur * 1.00
         WHEN 'L2A' THEN h.market_value_eur * 0.85
         WHEN 'L2B' THEN h.market_value_eur * 0.50
         ELSE 0 END                                      AS hqla_value_eur
FROM raw.treasury_hqla h;

-- Stressed 30-day outflows derived from stable/less-stable deposit balances.
CREATE TABLE risk.lcr_outflows AS
SELECT
    be.account_id,
    cm.country_code,
    be.ledger_balance_eur,
    CASE WHEN cm.customer_type = 'INDIVIDUAL' THEN be.ledger_balance_eur * 0.05
         ELSE be.ledger_balance_eur * 0.25 END           AS stressed_outflow_eur
FROM enrich.balances_eur be
JOIN enrich.account_base ab ON be.account_id = ab.account_id
JOIN enrich.customer_master cm ON ab.customer_id = cm.customer_id;

-- Expected 30-day inflows from performing exposures.
CREATE TABLE risk.lcr_inflows AS
SELECT
    e.country_code,
    SUM(e.ead_eur * 0.50)                               AS expected_inflow_eur
FROM risk.exposure e
JOIN risk.ifrs9_staging s ON e.account_id = s.account_id
WHERE s.ifrs9_stage IN ('STAGE_1', 'STAGE_2')
GROUP BY e.country_code;

-- COREP C 72/73 : the LCR itself = HQLA / net stressed outflows.
CREATE TABLE reg.corep_lcr AS
WITH outflow AS (
    SELECT country_code, SUM(stressed_outflow_eur) AS outflow_eur
    FROM risk.lcr_outflows
    GROUP BY country_code
),
hqla_total AS (
    SELECT SUM(hqla_value_eur) AS hqla_eur FROM risk.hqla
)
SELECT
    o.country_code,
    ht.hqla_eur,
    o.outflow_eur,
    COALESCE(i.expected_inflow_eur, 0)                  AS inflow_eur,
    GREATEST(o.outflow_eur - COALESCE(i.expected_inflow_eur, 0),
             0.25 * o.outflow_eur)                       AS net_outflow_eur,
    ROUND(ht.hqla_eur
          / NULLIF(GREATEST(o.outflow_eur
                   - COALESCE(i.expected_inflow_eur, 0),
                   0.25 * o.outflow_eur), 0) * 100, 1)   AS lcr_pct
FROM outflow o
CROSS JOIN hqla_total ht
LEFT JOIN risk.lcr_inflows i ON o.country_code = i.country_code;

-- ----------------------------------------------------------------------------
-- 8. FINAL SUPERVISORY PACK : one view the regulator receives
-- ----------------------------------------------------------------------------

CREATE VIEW reg.v_supervisory_pack AS
SELECT
    d.country_code,
    d.net_exposure_eur,
    d.rwa_eur,
    d.capital_requirement_eur,
    d.capital_ratio_pct,
    lcr.lcr_pct,
    le.large_exposure_count
FROM reg.v_group_regulatory_dashboard d
LEFT JOIN reg.corep_lcr lcr
       ON d.country_code = lcr.country_code
LEFT JOIN (
    SELECT 'ALL' AS country_code, COUNT(*) AS large_exposure_count
    FROM reg.corep_c2800
    WHERE exposure_class = 'LARGE_EXPOSURE'
) le ON 1 = 1;
