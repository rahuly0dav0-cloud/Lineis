# 04_sas_python_sql — adversarial lineage stress batch

Language chain: SAS → Python → SQL

## Why this is harder than a basic test
These files contain executable transformation patterns rather than comment-only padding: many derived metrics, repeated materializations, nested and recursive SQL, effective-dated joins, SAS hash/merge/PROC SQL/macro constructs, Python dynamic SQL and dataframe transforms, multiple outputs, and audit writes.

## Expected canonical core graph
```text
raw_b04.transactions ─────┐
raw_b04.customer_history ─┴─> work_b04.stage1 ──┐
                                               ├─> work_b04.stage2 ──┐
ref_b04.risk_rules ────────────────────────────┘                     ├─> work_b04.stage3 ──> mart_b04.customer_risk_daily
raw_b04.fx_rates ────────────────────────────────────────────────────┤
raw_b04.adjustments - - - - - - - - - - - - - - - - - - - - - - ->┘ (conditional)
```

Additional edges:
- `raw_b04.account_status` feeds generated scenario tables.
- `raw_b04.chargebacks` feeds UNION probes.
- The final mart is read by an audit insert in SQL variants.
- Python variants can write both database and Parquet sinks.

## Files and sizes
- `b04_stage1.sas`: SAS, 594 lines, substantive executable statements
- `b04_stage2.py`: Python, 611 lines, substantive executable statements
- `b04_stage3.sql`: SQL, 608 lines, substantive executable statements

## Ground truth
See `ground_truth.json`. The oracle identifies core canonical edges and semantic probes. Because scenario/metric objects are generated with patterned names, the parser should normalize and resolve them rather than collapsing them into a single guessed edge.

## Expected scoring
Evaluate table-level edge precision/recall, conditional-edge handling, sink detection, false-positive rate for unexecuted strings/comments, and transitive dependency correctness separately. For Python dynamic SQL, report static uncertainty if the runtime `suffix` cannot be resolved.
