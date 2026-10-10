# Lineis — BCBS 239 Data Lineage Engine (Layer 1)

Parses **SQL, SAS and Python** source code and reconstructs end-to-end data
lineage — tracing every regulatory number back to its foundation datasets.
Built as the Layer 1 engine for a DataHub-centric BCBS 239 programme.

## Features
- Multi-language parsing (sqlglot for SQL, regex for SAS, `ast` for Python).
- Cross-language stitching: `raw → stg → mart → reg` across files/platforms.
- Interactive DAG UI (Cytoscape) with source/intermediate/output classification.
- Evidence on every edge: file, line and code snippet.
- OpenLineage export for downstream catalog ingestion.

## Project structure
```
.
├── backend/            FastAPI app + parsers + graph engine
│   ├── app/
│   │   ├── parsers/    sql_parser, sas_parser, python_parser, naming
│   │   ├── graph.py    networkx graph + OpenLineage export
│   │   ├── models.py   IR (Dataset, Operation, ParseResult)
│   │   └── main.py     API endpoints
│   └── requirements.txt
├── frontend/           Static UI (index.html, static/app.js, static/style.css)
├── samples/            Small 3-language demo pipeline
├── test_batches/       Larger "tricky" batches (sql_only, sas_only, mixed)
└── docs/               Pitch deck + problem statement
```

## Run locally
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
Open http://127.0.0.1:8000 and click **Load quick demo** or a test batch.

## Status
Prototype. Lineage uses loose name-matching across languages (a deliberate
Layer 1 simplification); column-level lineage and an AI review layer are planned.
