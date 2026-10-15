-- Stage 4 (SQL) · Publish the FINREP F18.00 non-performing exposure line.
-- The report layer renames and rescales the mart figures into the supervisory
-- template (ratios expressed in percent).

CREATE TABLE reg.finrep_f1800_npl AS
SELECT
    segment                                               AS report_row,
    npl_exposure_eur                                      AS npl_exposure_eur,
    total_exposure_eur                                    AS gross_carrying_amount_eur,
    npl_coverage_ratio * 100                              AS npl_coverage_ratio_pct,
    npl_exposure_eur / NULLIF(total_exposure_eur, 0) * 100 AS npl_ratio_pct
FROM mart.npl_by_segment;
