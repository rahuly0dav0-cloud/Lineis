-- Stage 1 (SQL) · Build the high-quality liquid asset (HQLA) buffer.
-- Source layer of the COREP C72.00 Liquidity Coverage Ratio pipeline.
-- hqla_value_eur is a simple haircut calculation, so field-level lineage is
-- fully resolvable at this stage.

CREATE TABLE stg.hqla AS
SELECT
    s.security_id                                         AS security_id,
    s.asset_class                                         AS asset_class,
    s.market_value                                        AS market_value_eur,
    s.regulatory_haircut                                  AS haircut_pct,
    -- HQLA value after supervisory haircut
    s.market_value * (1 - s.regulatory_haircut)           AS hqla_value_eur,
    s.lcr_level                                           AS hqla_level
FROM raw.securities s
WHERE s.lcr_eligible = 1;
