/* Stage 2 (SAS) · Stressed 30-day net cash outflow engine.

   The liquidity stress factor is pulled at RUNTIME from a scenario table via
   SELECT INTO :macro, and the per-deposit outflow is computed inside a DATA
   step. The static parser only resolves this step at table level, so the
   field-level trace for the downstream LCR figure stops here.

   => Genuine SAS boundary. The AI layer can read the DATA step and recover the
      outflow formula (balance × runoff × stress factor) and its inputs. */

proc sql;
  select stress_multiplier into :stress_factor
  from risk.liquidity_scenarios
  where scenario = 'COMBINED_STRESS';
quit;

data work.net_outflows;
  set raw.deposits;

  /* Behavioural runoff rate by deposit type, applied under stress */
  if deposit_type = 'RETAIL_STABLE'       then runoff_rate = 0.05;
  else if deposit_type = 'RETAIL_OTHER'   then runoff_rate = 0.10;
  else if deposit_type = 'OPERATIONAL'    then runoff_rate = 0.25;
  else runoff_rate = 0.40;

  /* Stressed 30-day outflow for the deposit */
  outflow_eur = balance_eur * runoff_rate * &stress_factor.;
run;
