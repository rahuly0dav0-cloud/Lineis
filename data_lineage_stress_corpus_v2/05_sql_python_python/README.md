# 05_sql_python_python — adversarial lineage stress batch

Language chain: SQL → Python → Python

## Why this is harder than a basic test
These files contain executable transformation patterns rather than comment-only padding: many derived metrics, repeated materializations, nested and recursive SQL, effective-dated joins, SAS hash/merge/PROC SQL/macro constructs, Python dynamic SQL and dataframe transforms, multiple outputs, and audit writes.

## Expected canonical core graph
```text
raw_b05.transactions ─────┐
raw_b05.customer_history ─┴─> work_b05.stage1 ──┐
                                               ├─> work_b05.stage2 ──┐
ref_b05.risk_rules ────────────────────────────┘                     ├─> work_b05.stage3 ──> mart_b05.customer_risk_daily
raw_b05.fx_rates ────────────────────────────────────────────────────┤
raw_b05.adjustments - - - - - - - - - - - - - - - - - - - - - - ->┘ (conditional)
```

Additional edges:
- `raw_b05.account_status` feeds generated scenario tables.
- `raw_b05.chargebacks` feeds UNION probes.
- The final mart is read by an audit insert in SQL variants.
- Python variants can write both database and Parquet sinks.

## Files and sizes
- `b05_stage1.sql`: SQL, 608 lines, substantive executable statements
- `b05_stage2.py`: Python, 611 lines, substantive executable statements
- `b05_stage3.py`: Python, 611 lines, substantive executable statements

## Ground truth
See `ground_truth.json`. The oracle identifies core canonical edges and semantic probes. Because scenario/metric objects are generated with patterned names, the parser should normalize and resolve them rather than collapsing them into a single guessed edge.

## Expected scoring
Evaluate table-level edge precision/recall, conditional-edge handling, sink detection, false-positive rate for unexecuted strings/comments, and transitive dependency correctness separately. For Python dynamic SQL, report static uncertainty if the runtime `suffix` cannot be resolved.
