# Data Lineage Stress Corpus v2

This is the harder second-generation benchmark intended to push an already functional parser. Each of the 30 source files has at least 500 lines and is populated with executable transformations, generated metric materializations, joins, merges, conditional reads, and output operations rather than comment-only padding.

The corpus is adversarial and synthetic. Some snippets are dialect-specific and may need a matching SQL/SAS runtime to execute. The ground truth is an expected logical graph with explicit notes where runtime-generated table names require uncertainty-aware analysis.

Scoring priorities:
1. Exact table-edge precision and recall.
2. Correct direct vs transitive lineage.
3. Correct column-level provenance (where supported).
4. Correct conditional/dynamic lineage classification.
5. Sink detection, including audit and file sinks.
6. No edges from comments or non-executed SQL strings.
7. Stable identifier normalization across language dialects.
