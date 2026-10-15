"""Stage 5 (Python) · PD back-testing summary by segment.

Reads the staged loan book and produces an average-PD view used by the model
monitoring pack. Python transforms expose table-level lineage only, so the
field-level trace for avg_pd stops at this Python boundary until the AI layer
reads the code and recovers the group-by aggregation.
"""
import pandas as pd


def build_pd_backtest(conn):
    loan_book = pd.read_sql(
        "SELECT account_id, segment, pd FROM stg.loan_book", conn
    )

    pd_backtest = (
        loan_book
        .groupby("segment", as_index=False)
        .agg(
            avg_pd=("pd", "mean"),
            accounts=("account_id", "count"),
        )
    )

    pd_backtest.to_sql("mart.pd_backtest", conn, if_exists="replace", index=False)
    return pd_backtest
