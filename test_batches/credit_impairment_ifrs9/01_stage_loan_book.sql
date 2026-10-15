-- Stage 1 (SQL) · Build the cleaned loan book from raw core-banking extracts.
-- This is the source layer of the IFRS 9 / FINREP impairment pipeline.
-- Every field below is either a direct mapping (a renamed source column) or a
-- simple calculation, so field-level lineage is fully resolvable here.

CREATE TABLE stg.loan_book AS
SELECT
    a.account_id                                          AS account_id,
    a.segment                                             AS segment,
    a.current_balance                                     AS current_balance_eur,
    c.collateral_value                                    AS collateral_value_eur,
    -- Exposure at default = drawn balance + credit-converted undrawn commitment
    a.current_balance + COALESCE(a.undrawn_commitment, 0) * a.credit_conversion_factor
                                                          AS ead_eur,
    a.pd_12m                                              AS pd,
    a.lgd_downturn                                        AS lgd,
    a.days_past_due                                       AS days_past_due
FROM raw.loan_accounts a
LEFT JOIN raw.collateral c
       ON a.account_id = c.account_id;
