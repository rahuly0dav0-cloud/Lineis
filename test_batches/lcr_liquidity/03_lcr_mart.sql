-- Stage 3 (SQL) · Aggregate the HQLA buffer and stressed outflows into the
-- Liquidity Coverage Ratio. Both totals and the ratio are resolvable here;
-- the outflow branch inherits the SAS boundary from stage 2.

CREATE TABLE mart.lcr_summary AS
SELECT
    h.total_hqla_eur                                      AS total_hqla_eur,
    o.total_outflows_eur                                  AS total_net_outflows_eur,
    -- Liquidity Coverage Ratio = HQLA buffer / stressed net outflows
    h.total_hqla_eur / NULLIF(o.total_outflows_eur, 0)    AS lcr_ratio
FROM (
    SELECT SUM(hqla_value_eur) AS total_hqla_eur
    FROM stg.hqla
) h
CROSS JOIN (
    SELECT SUM(outflow_eur) AS total_outflows_eur
    FROM work.net_outflows
) o;
