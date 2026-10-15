/* Stage 2 (SAS) · IFRS 9 expected-credit-loss (ECL) engine.

   The lifetime ECL is scenario-weighted. The scenario weight is pulled at
   RUNTIME from a parameter table through SELECT INTO :macro, so the static
   parser cannot see the numeric value or close the field-level lineage across
   this step. lifetime_ecl_eur is then computed inside a DATA step, which the
   parser only resolves at table level.

   => This is a genuine SAS boundary: the column trace for the downstream
      "Accumulated impairment" figure stops here. The AI layer can read the code
      and recover the formula and its contributing fields. */

proc sql;
  select weight into :scenario_weight
  from risk.macro_scenarios
  where scenario = 'BASELINE';
quit;

data work.ecl_by_account;
  set stg.loan_book;

  /* Time-value discounting on the days-past-due horizon */
  discount_factor  = 1 / (1 + 0.05) ** (days_past_due / 365);

  /* Scenario-weighted lifetime expected credit loss */
  lifetime_ecl_eur = &scenario_weight. * ead_eur * pd * lgd * discount_factor;

  /* IFRS 9 staging */
  if days_past_due >= 90 then stage = 3;
  else if days_past_due >= 30 then stage = 2;
  else stage = 1;
run;
