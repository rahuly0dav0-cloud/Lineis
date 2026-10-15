"""Stage 2 (Python) · Non-performing exposure (NPE) classification.

Reads the staged exposures and flags each loan as non-performing under the
EBA definition (90+ days past due, or forborne and unlikely to pay). The NPE
flag is computed in pandas, so the field-level trace for the downstream
"Non-performing exposures" figure stops at this Python boundary until the AI
layer reads the code and recovers the classification rule.
"""
import pandas as pd


def classify_npl(conn):
    exposures = pd.read_sql(
        "SELECT loan_id, segment, exposure_eur, provision_eur, "
        "days_past_due, forbearance_flag FROM stg.exposures",
        conn,
    )

    # EBA non-performing definition: 90+ dpd, or forborne unlikely-to-pay
    exposures["is_npl"] = (
        (exposures["days_past_due"] >= 90)
        | (exposures["forbearance_flag"] == 1)
    ).astype(int)

    exposures["npl_exposure_eur"] = exposures["exposure_eur"] * exposures["is_npl"]

    npl_flagged = exposures[
        ["loan_id", "segment", "exposure_eur", "npl_exposure_eur",
         "provision_eur", "is_npl"]
    ]

    npl_flagged.to_sql("work.npl_flagged", conn, if_exists="replace", index=False)
    return npl_flagged
