-- Stage 3 - build the BCBS 239 regulatory reporting layer (SQL).
-- Consumes the SAS mart tables (customer_accounts, txn_summary, collateral_clean)
-- and produces the exposures base, the FINREP/COREP report tables, and the
-- consolidated board risk view.

CREATE TABLE mart.exposures AS
SELECT
    ca.customer_id,
    ca.account_id,
    ca.country,
    ts.total_amount_eur        AS exposure_eur,
    ts.txn_count,
    cc.collateral_value_eur
FROM mart.customer_accounts ca
LEFT JOIN mart.txn_summary       ts ON ca.account_id = ts.account_id
LEFT JOIN mart.collateral_clean  cc ON ca.account_id = cc.account_id;

-- FINREP F 04.01 - financial assets by country.
CREATE TABLE reg.finrep_f0401 AS
SELECT
    country,
    SUM(exposure_eur)          AS gross_carrying_amount,
    SUM(collateral_value_eur)  AS collateral_amount
FROM mart.exposures
GROUP BY country;

-- COREP C 07.00 - credit risk exposure net of collateral.
CREATE TABLE reg.corep_c0700 AS
SELECT
    country,
    SUM(exposure_eur - collateral_value_eur) AS net_exposure_eur
FROM mart.exposures
GROUP BY country;

-- Consolidated board-level risk report.
CREATE VIEW reg.board_risk_report AS
SELECT
    f.country,
    f.gross_carrying_amount,
    f.collateral_amount,
    c.net_exposure_eur
FROM reg.finrep_f0401 f
JOIN reg.corep_c0700 c ON f.country = c.country;
