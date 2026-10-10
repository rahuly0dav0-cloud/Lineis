-- ============================================================================
--  Mortgage FINREP pipeline - STAGE 3: regulatory reporting (SQL).
--  Consumes the SAS mart tables (mortgage_risk_features, forbearance_candidates,
--  property_valuation, payment_behaviour) and produces the FINREP / COREP
--  mortgage outputs plus the consolidated board view.
--
--  Cross-language stitching: the mart.* inputs are written by 02_enrich.sas,
--  which in turn consumes the stg_* datasets written by 01_ingest.py.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Exposure base with EAD and collateral netting
-- ----------------------------------------------------------------------------

CREATE TABLE reg.mortgage_exposure AS
SELECT
    f.account_id,
    f.customer_id,
    f.country,
    f.ltv_band,
    f.ifrs9_stage,
    f.current_balance                                  AS drawn_eur,
    f.collateral_value_eur,
    GREATEST(f.current_balance - f.collateral_value_eur, 0) AS net_exposure_eur,
    pb.payment_profile
FROM mart.mortgage_risk_features f
LEFT JOIN mart.payment_behaviour pb
       ON f.account_id = pb.account_id;

-- ----------------------------------------------------------------------------
-- 2. Expected credit loss by stage
-- ----------------------------------------------------------------------------

CREATE TABLE reg.mortgage_ecl AS
WITH pd_lookup AS (
    SELECT account_id,
           CASE ifrs9_stage WHEN 1 THEN 0.008
                            WHEN 2 THEN 0.040
                            ELSE 0.220 END             AS pd,
           0.20                                        AS lgd
    FROM mart.mortgage_risk_features
)
SELECT
    e.account_id,
    e.country,
    e.ltv_band,
    e.ifrs9_stage,
    e.net_exposure_eur,
    p.pd,
    p.lgd,
    CASE e.ifrs9_stage
         WHEN 1 THEN e.net_exposure_eur * p.pd * p.lgd
         WHEN 2 THEN e.net_exposure_eur * p.pd * p.lgd * 2.5
         ELSE e.net_exposure_eur * p.lgd
    END                                                AS ecl_eur
FROM reg.mortgage_exposure e
JOIN pd_lookup p
      ON e.account_id = p.account_id;

-- ----------------------------------------------------------------------------
-- 3. Risk-weighted assets (standardised, LTV-sensitive)
-- ----------------------------------------------------------------------------

CREATE TABLE reg.mortgage_rwa AS
SELECT
    account_id,
    country,
    ltv_band,
    net_exposure_eur,
    CASE ltv_band
         WHEN 'LE60'  THEN net_exposure_eur * 0.35
         WHEN '60_80' THEN net_exposure_eur * 0.50
         WHEN '80_90' THEN net_exposure_eur * 0.75
         WHEN 'GT90'  THEN net_exposure_eur * 1.00
         ELSE net_exposure_eur * 0.75
    END                                                AS rwa_eur
FROM reg.mortgage_exposure;

-- ----------------------------------------------------------------------------
-- 4. FINREP F 18.00 : performing / non-performing by country and stage
-- ----------------------------------------------------------------------------

CREATE TABLE reg.finrep_f1800 AS
SELECT
    e.country,
    e.ifrs9_stage,
    CASE WHEN e.ifrs9_stage = 3 THEN 'NON_PERFORMING'
         ELSE 'PERFORMING' END                         AS performance_status,
    COUNT(*)                                           AS account_count,
    SUM(e.drawn_eur)                                   AS gross_carrying_eur,
    SUM(e.collateral_value_eur)                        AS collateral_eur,
    SUM(ecl.ecl_eur)                                   AS impairment_eur
FROM reg.mortgage_exposure e
JOIN reg.mortgage_ecl ecl
      ON e.account_id = ecl.account_id
GROUP BY e.country, e.ifrs9_stage;

-- ----------------------------------------------------------------------------
-- 5. COREP mortgage RWA by country
-- ----------------------------------------------------------------------------

CREATE TABLE reg.corep_mortgage_rwa AS
SELECT
    country,
    SUM(net_exposure_eur)                              AS net_exposure_eur,
    SUM(rwa_eur)                                       AS rwa_eur,
    SUM(rwa_eur) * 0.08                                AS capital_requirement_eur
FROM reg.mortgage_rwa
GROUP BY country;

-- ----------------------------------------------------------------------------
-- 6. Forbearance regulatory report (from the SAS forbearance candidates)
-- ----------------------------------------------------------------------------

CREATE TABLE reg.forbearance_report AS
SELECT
    fc.country,
    fc.forbearance_type,
    COUNT(*)                                           AS case_count,
    SUM(fc.current_balance)                            AS forborne_balance_eur,
    AVG(fc.max_dpd)                                    AS avg_days_past_due
FROM mart.forbearance_candidates fc
GROUP BY fc.country, fc.forbearance_type;

-- ----------------------------------------------------------------------------
-- 7. Board-level consolidated mortgage risk view (final artefact)
-- ----------------------------------------------------------------------------

CREATE VIEW reg.v_mortgage_board_pack AS
SELECT
    c.country,
    c.net_exposure_eur,
    c.rwa_eur,
    c.capital_requirement_eur,
    i.impairment_eur,
    i.gross_carrying_eur,
    fb.forborne_balance_eur,
    ROUND(i.impairment_eur / NULLIF(i.gross_carrying_eur, 0) * 100, 2)
                                                       AS coverage_ratio_pct
FROM reg.corep_mortgage_rwa c
LEFT JOIN (
    SELECT country,
           SUM(impairment_eur)    AS impairment_eur,
           SUM(gross_carrying_eur) AS gross_carrying_eur
    FROM reg.finrep_f1800
    GROUP BY country
) i ON c.country = i.country
LEFT JOIN (
    SELECT country, SUM(forborne_balance_eur) AS forborne_balance_eur
    FROM reg.forbearance_report
    GROUP BY country
) fb ON c.country = fb.country;

-- ----------------------------------------------------------------------------
-- 8. Indexed-LTV impact : re-run RWA on indexed collateral (from full features)
-- ----------------------------------------------------------------------------

CREATE TABLE reg.mortgage_rwa_indexed AS
SELECT
    f.account_id,
    f.country,
    f.indexed_ltv_band,
    f.net_exposure_eur,
    CASE f.indexed_ltv_band
         WHEN 'LE60'  THEN f.net_exposure_eur * 0.35
         WHEN '60_80' THEN f.net_exposure_eur * 0.50
         WHEN '80_90' THEN f.net_exposure_eur * 0.75
         WHEN 'GT90'  THEN f.net_exposure_eur * 1.00
         ELSE f.net_exposure_eur * 0.75
    END                                                AS rwa_indexed_eur
FROM mart.mortgage_full_features f;

CREATE TABLE reg.rwa_index_comparison AS
SELECT
    base.country,
    SUM(base.rwa_eur)                                  AS rwa_point_in_time_eur,
    SUM(idx.rwa_indexed_eur)                           AS rwa_indexed_eur,
    SUM(idx.rwa_indexed_eur) - SUM(base.rwa_eur)       AS rwa_delta_eur
FROM reg.mortgage_rwa base
JOIN reg.mortgage_rwa_indexed idx
      ON base.account_id = idx.account_id
GROUP BY base.country;

-- ----------------------------------------------------------------------------
-- 9. Securitisation capital relief : exclude sold tranches from RWA
-- ----------------------------------------------------------------------------

CREATE TABLE reg.securitisation_relief AS
SELECT
    r.country,
    SUM(CASE WHEN sf.retention_status = 'SOLD'
             THEN r.rwa_eur ELSE 0 END)                AS relieved_rwa_eur,
    SUM(CASE WHEN sf.retention_status = 'RETAINED'
             THEN r.rwa_eur ELSE 0 END)                AS retained_rwa_eur
FROM reg.mortgage_rwa r
JOIN mart.securitisation_flags sf
      ON r.account_id = sf.account_id
GROUP BY r.country;

-- ----------------------------------------------------------------------------
-- 10. Rating migration report : up/downgrade counts by direction
-- ----------------------------------------------------------------------------

CREATE TABLE reg.rating_migration_report AS
SELECT
    rm.migration_direction,
    COUNT(*)                                           AS customer_count,
    AVG(rm.notch_change)                               AS avg_notch_change
FROM mart.rating_migration rm
GROUP BY rm.migration_direction;

-- ----------------------------------------------------------------------------
-- 11. Net interest income : period interest aggregated to country
-- ----------------------------------------------------------------------------

CREATE TABLE reg.interest_income AS
SELECT
    f.country,
    SUM(isum.period_interest_eur)                      AS total_interest_eur,
    AVG(isum.period_interest_eur)                      AS avg_interest_eur
FROM mart.interest_summary isum
JOIN mart.mortgage_full_features f
      ON isum.account_id = f.account_id
GROUP BY f.country;

-- ----------------------------------------------------------------------------
-- 12. Vintage analysis : balances and stage mix by origination year
-- ----------------------------------------------------------------------------

CREATE TABLE reg.vintage_analysis AS
SELECT
    vc.origination_year,
    vc.ifrs9_stage,
    vc.cohort_balance_eur,
    vc.cohort_account_count,
    ROUND(vc.cohort_balance_eur
          / NULLIF(SUM(vc.cohort_balance_eur)
                   OVER (PARTITION BY vc.origination_year), 0) * 100, 2)
                                                       AS pct_of_vintage
FROM mart.vintage_cohorts vc;

-- ----------------------------------------------------------------------------
-- 13. Bureau segmentation : exposure split by external credit band
-- ----------------------------------------------------------------------------

CREATE TABLE reg.bureau_segmentation AS
SELECT
    be.bureau_band,
    COUNT(*)                                           AS customer_count,
    SUM(e.net_exposure_eur)                            AS net_exposure_eur,
    AVG(be.score_trend)                                AS avg_score_trend
FROM mart.bureau_enriched be
JOIN reg.mortgage_exposure e
      ON be.customer_id = e.customer_id
GROUP BY be.bureau_band;

-- ----------------------------------------------------------------------------
-- 14. Insurance coverage report : protected vs unprotected exposure
-- ----------------------------------------------------------------------------

CREATE TABLE reg.insurance_coverage_report AS
SELECT
    f.country,
    f.coverage_flag,
    COUNT(*)                                           AS account_count,
    SUM(f.net_exposure_eur)                            AS net_exposure_eur,
    AVG(ins.max_loss_ratio)                            AS avg_loss_ratio
FROM mart.mortgage_full_features f
LEFT JOIN mart.insurance_summary ins
       ON f.account_id = ins.account_id
GROUP BY f.country, f.coverage_flag;

-- ----------------------------------------------------------------------------
-- 15. Enhanced board pack : the point-in-time board view plus indexed,
--     securitisation, interest and coverage overlays (final artefact)
-- ----------------------------------------------------------------------------

CREATE VIEW reg.v_mortgage_supervisory_pack AS
SELECT
    bp.country,
    bp.net_exposure_eur,
    bp.rwa_eur,
    bp.capital_requirement_eur,
    bp.impairment_eur,
    bp.coverage_ratio_pct,
    ric.rwa_indexed_eur,
    ric.rwa_delta_eur,
    sr.relieved_rwa_eur,
    ii.total_interest_eur,
    icr.net_exposure_eur                               AS covered_exposure_eur
FROM reg.v_mortgage_board_pack bp
LEFT JOIN reg.rwa_index_comparison ric
       ON bp.country = ric.country
LEFT JOIN reg.securitisation_relief sr
       ON bp.country = sr.country
LEFT JOIN reg.interest_income ii
       ON bp.country = ii.country
LEFT JOIN (
    SELECT country, SUM(net_exposure_eur) AS net_exposure_eur
    FROM reg.insurance_coverage_report
    WHERE coverage_flag = 'COVERED'
    GROUP BY country
) icr ON bp.country = icr.country;

-- ----------------------------------------------------------------------------
-- 16. Guarantee-adjusted RWA : recompute capital on net-of-guarantee exposure
-- ----------------------------------------------------------------------------

CREATE TABLE reg.guarantee_adjusted_rwa AS
SELECT
    ga.country,
    SUM(ga.adjusted_exposure_eur)                      AS adjusted_exposure_eur,
    SUM(ga.adjusted_exposure_eur * 0.50)               AS adjusted_rwa_eur,
    SUM(ga.guaranteed_eur)                             AS guaranteed_eur
FROM mart.guarantee_adjusted ga
GROUP BY ga.country;

-- ----------------------------------------------------------------------------
-- 17. Forbearance overlay : servicing-driven forbearance vs model stage
-- ----------------------------------------------------------------------------

CREATE TABLE reg.servicing_forbearance AS
SELECT
    se.servicing_flag,
    se.ifrs9_stage,
    COUNT(*)                                           AS account_count
FROM mart.servicing_enriched se
GROUP BY se.servicing_flag, se.ifrs9_stage;

-- ----------------------------------------------------------------------------
-- 18. Hedge coverage : effective hedge notional vs banking-book exposure
-- ----------------------------------------------------------------------------

CREATE TABLE reg.hedge_coverage AS
SELECT
    he.effectiveness_band,
    COUNT(*)                                           AS swap_count,
    SUM(he.notional_eur)                               AS notional_eur
FROM mart.hedging_effectiveness he
GROUP BY he.effectiveness_band;

-- ----------------------------------------------------------------------------
-- 19. Present-value interest : discounted interest income by account band
-- ----------------------------------------------------------------------------

CREATE TABLE reg.pv_interest_report AS
SELECT
    f.country,
    SUM(di.pv_interest_eur)                            AS pv_interest_eur,
    SUM(di.period_interest_eur)                        AS nominal_interest_eur
FROM mart.discounted_interest di
JOIN mart.mortgage_full_features f
      ON di.account_id = f.account_id
GROUP BY f.country;

-- ----------------------------------------------------------------------------
-- 20. Term-structure report : exposure by remaining-term band
-- ----------------------------------------------------------------------------

CREATE TABLE reg.term_structure AS
SELECT
    lt.country,
    lt.term_band,
    COUNT(*)                                           AS account_count,
    SUM(lt.current_balance)                            AS balance_eur,
    AVG(lt.monthly_instalment)                         AS avg_instalment_eur
FROM mart.loan_term_features lt
GROUP BY lt.country, lt.term_band;

-- ----------------------------------------------------------------------------
-- 21. Stress impact : scenario balance uplift vs base
-- ----------------------------------------------------------------------------

CREATE TABLE reg.stress_impact AS
SELECT
    sr.scenario_id,
    sr.base_balance_eur,
    sr.stressed_balance_eur,
    sr.stressed_balance_eur - sr.base_balance_eur      AS balance_uplift_eur,
    ROUND((sr.stressed_balance_eur - sr.base_balance_eur)
          / NULLIF(sr.base_balance_eur, 0) * 100, 2)   AS uplift_pct
FROM mart.stress_results sr;

-- ----------------------------------------------------------------------------
-- 22. Cost-centre P&L proxy : net exposure and interest by branch rollup
-- ----------------------------------------------------------------------------

CREATE TABLE reg.cost_centre_report AS
SELECT
    br.region_name,
    br.cost_centre,
    br.account_count,
    br.net_exposure_eur
FROM mart.branch_rollup br;

-- ----------------------------------------------------------------------------
-- 23. Final group supervisory artefact : everything the regulator receives
-- ----------------------------------------------------------------------------

CREATE VIEW reg.v_mortgage_group_submission AS
SELECT
    sp.country,
    sp.net_exposure_eur,
    sp.rwa_eur,
    sp.capital_requirement_eur,
    sp.impairment_eur,
    sp.coverage_ratio_pct,
    sp.rwa_indexed_eur,
    sp.total_interest_eur,
    gar.adjusted_rwa_eur,
    gar.guaranteed_eur,
    pv.pv_interest_eur
FROM reg.v_mortgage_supervisory_pack sp
LEFT JOIN reg.guarantee_adjusted_rwa gar
       ON sp.country = gar.country
LEFT JOIN reg.pv_interest_report pv
       ON sp.country = pv.country;
