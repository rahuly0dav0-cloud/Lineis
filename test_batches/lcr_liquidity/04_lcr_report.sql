-- Stage 4 (SQL) · Publish the COREP C72.00 Liquidity Coverage Ratio line.
-- The regulatory report layer renames and rescales the mart figures into the
-- supervisory template.

CREATE TABLE reg.corep_c72_lcr AS
SELECT
    'LCR' AS report_item,
    -- Reported ratio in percent
    lcr_ratio * 100                                       AS lcr_ratio_pct,
    total_hqla_eur                                        AS hqla_eur,
    total_net_outflows_eur                                AS net_outflows_eur
FROM mart.lcr_summary;
