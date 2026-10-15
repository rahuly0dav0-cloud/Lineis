-- Stage 4 (SQL) · Publish the FINREP F18.04 impairment report rows.
-- These are the figures that land in the regulatory return. "report_row" is the
-- template row (segment); accumulated_impairment_eur is the reported allowance.

CREATE TABLE reg.finrep_f1804_impairment AS
SELECT
    m.segment                                    AS report_row,
    m.accumulated_impairment_eur                 AS accumulated_impairment_eur,
    m.total_ead_eur                              AS gross_carrying_amount_eur,
    m.coverage_ratio * 100                       AS coverage_ratio_pct
FROM mart.impairment_by_segment m;
