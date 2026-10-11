# 07_python_sql_sas — adversarial lineage stress batch

Language chain: Python → SQL → SAS

## Why this is harder than a basic test
These files contain executable transformation patterns rather than comment-only padding: many derived metrics, repeated materializations, nested and recursive SQL, effective-dated joins, SAS hash/merge/PROC SQL/macro constructs, Python dynamic SQL and dataframe transforms, multiple outputs, and audit writes.

## Expected canonical core graph
```text
raw_b07.transactions ─────┐
raw_b07.customer_history ─┴─> work_b07.stage1 ──┐
                                               ├─> work_b07.stage2 ──┐
ref_b07.risk_rules ────────────────────────────┘                     ├─> work_b07.stage3 ──> mart_b07.customer_risk_daily
raw_b07.fx_rates ────────────────────────────────────────────────────┤
raw_b07.adjustments - - - - - - - - - - - - - - - - - - - - - - ->┘ (conditional)
```

Additional edges:
- `raw_b07.account_status` feeds generated scenario tables.
- `raw_b07.chargebacks` feeds UNION probes.
- The final mart is read by an audit insert in SQL variants.
- Python variants can write both database and Parquet sinks.

## Files and sizes
- `b07_stage1.py`: Python, 611 lines, substantive executable statements
- `b07_stage2.sql`: SQL, 608 lines, substantive executable statements
- `b07_stage3.sas`: SAS, 594 lines, substantive executable statements

## Ground truth
See `ground_truth.json`. The oracle identifies core canonical edges and semantic probes. Because scenario/metric objects are generated with patterned names, the parser should normalize and resolve them rather than collapsing them into a single guessed edge.

## Expected scoring
Evaluate table-level edge precision/recall, conditional-edge handling, sink detection, false-positive rate for unexecuted strings/comments, and transitive dependency correctness separately. For Python dynamic SQL, report static uncertainty if the runtime `suffix` cannot be resolved.
