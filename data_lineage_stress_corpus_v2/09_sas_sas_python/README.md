# 09_sas_sas_python — adversarial lineage stress batch

Language chain: SAS → SAS → Python

## Why this is harder than a basic test
These files contain executable transformation patterns rather than comment-only padding: many derived metrics, repeated materializations, nested and recursive SQL, effective-dated joins, SAS hash/merge/PROC SQL/macro constructs, Python dynamic SQL and dataframe transforms, multiple outputs, and audit writes.

## Expected canonical core graph
```text
raw_b09.transactions ─────┐
raw_b09.customer_history ─┴─> work_b09.stage1 ──┐
                                               ├─> work_b09.stage2 ──┐
ref_b09.risk_rules ────────────────────────────┘                     ├─> work_b09.stage3 ──> mart_b09.customer_risk_daily
raw_b09.fx_rates ────────────────────────────────────────────────────┤
raw_b09.adjustments - - - - - - - - - - - - - - - - - - - - - - ->┘ (conditional)
```

Additional edges:
- `raw_b09.account_status` feeds generated scenario tables.
- `raw_b09.chargebacks` feeds UNION probes.
- The final mart is read by an audit insert in SQL variants.
- Python variants can write both database and Parquet sinks.

## Files and sizes
- `b09_stage1.sas`: SAS, 594 lines, substantive executable statements
- `b09_stage2.sas`: SAS, 594 lines, substantive executable statements
- `b09_stage3.py`: Python, 611 lines, substantive executable statements

## Ground truth
See `ground_truth.json`. The oracle identifies core canonical edges and semantic probes. Because scenario/metric objects are generated with patterned names, the parser should normalize and resolve them rather than collapsing them into a single guessed edge.

## Expected scoring
Evaluate table-level edge precision/recall, conditional-edge handling, sink detection, false-positive rate for unexecuted strings/comments, and transitive dependency correctness separately. For Python dynamic SQL, report static uncertainty if the runtime `suffix` cannot be resolved.
