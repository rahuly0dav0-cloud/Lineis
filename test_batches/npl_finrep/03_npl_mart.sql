-- Stage 3 (SQL) · Aggregate the flagged exposures to segment level.
-- The NPE amount and coverage ratio are resolvable here; the NPE-flag branch
-- inherits the Python boundary from stage 2.

CREATE TABLE mart.npl_by_segment AS
SELECT
    segment                                               AS segment,
    SUM(exposure_eur)                                     AS total_exposure_eur,
    SUM(npl_exposure_eur)                                 AS npl_exposure_eur,
    SUM(provision_eur)                                    AS npl_provision_eur,
    -- Coverage = provisions held against the non-performing book
    SUM(provision_eur) / NULLIF(SUM(npl_exposure_eur), 0) AS npl_coverage_ratio
FROM work.npl_flagged
GROUP BY segment;
