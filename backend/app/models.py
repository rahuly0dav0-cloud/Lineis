"""Intermediate representation shared by every language parser.

Each parser turns source code into a `ParseResult`: a set of datasets (nodes)
and operations (edges). The graph layer and the UI only ever see this IR, which
is what lets SQL, SAS and Python lineage stitch into a single graph.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class Dataset(BaseModel):
    id: str                      # normalized key used for cross-file stitching
    name: str                    # human-readable / qualified name for display
    type: str = "table"          # table | view | file | dataframe | unknown
    namespace: str = "default"
    source_file: Optional[str] = None


class ColumnEdge(BaseModel):
    target_column: str
    source_columns: List[str] = Field(default_factory=list)


class Operation(BaseModel):
    """A single transformation: inputs -> target."""

    id: str
    kind: str                    # ctas | view | insert | select | datastep |
                                 # merge | proc | read | write | unknown
    target: str                  # dataset id produced
    inputs: List[str] = Field(default_factory=list)   # dataset ids consumed
    columns: List[str] = Field(default_factory=list)  # output cols (best effort)
    column_map: List[ColumnEdge] = Field(default_factory=list)
    file: str = ""
    language: str = ""
    line_start: int = 0
    line_end: int = 0
    snippet: str = ""
    confidence: str = "high"     # high | medium | low
    notes: Optional[str] = None


class ParseResult(BaseModel):
    datasets: Dict[str, Dataset] = Field(default_factory=dict)
    operations: List[Operation] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

    def merge(self, other: "ParseResult") -> None:
        for ds_id, ds in other.datasets.items():
            existing = self.datasets.get(ds_id)
            if existing is None or (existing.type in ("unknown", "dataframe")
                                    and ds.type not in ("unknown", "dataframe")):
                self.datasets[ds_id] = ds
        self.operations.extend(other.operations)
        self.warnings.extend(other.warnings)
