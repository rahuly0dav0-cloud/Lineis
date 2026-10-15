-- Stage 1 (SQL) · Build the exposure base for non-performing exposure (NPE)
-- reporting. Source layer of the FINREP F18.00 pipeline. Every field is a
-- direct mapping or simple join, so field-level lineage is resolvable here.

CREATE TABLE stg.exposures AS
SELECT
    l.loan_id                                             AS loan_id,
    l.segment                                             AS segment,
    l.gross_carrying_amount                               AS exposure_eur,
    l.accumulated_provision                               AS provision_eur,
    COALESCE(ar.days_in_arrears, 0)                       AS days_past_due,
    ar.forbearance_flag                                   AS forbearance_flag
FROM raw.loans l
LEFT JOIN raw.arrears ar
       ON l.loan_id = ar.loan_id;
