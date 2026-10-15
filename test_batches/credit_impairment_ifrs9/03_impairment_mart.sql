-- Stage 3 (SQL) · Aggregate account-level ECL into the segment impairment mart.
-- accumulated_impairment_eur is the SUM of account lifetime ECL; the coverage
-- ratio divides it by total exposure. Field-level lineage is resolvable back to
-- work.ecl_by_account (which is itself fed by the SAS boundary upstream).

CREATE TABLE mart.impairment_by_segment AS
SELECT
    e.segment                                    AS segment,
    SUM(e.lifetime_ecl_eur)                      AS accumulated_impairment_eur,
    SUM(e.ead_eur)                               AS total_ead_eur,
    SUM(e.lifetime_ecl_eur) / NULLIF(SUM(e.ead_eur), 0)
                                                 AS coverage_ratio
FROM work.ecl_by_account e
GROUP BY e.segment;
