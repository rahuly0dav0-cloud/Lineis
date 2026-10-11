"""Stress fixture b04 stage 2; pandas + SQLAlchemy, dynamic SQL, aliasing, multiple sinks."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import json
import pandas as pd
from sqlalchemy import text
BATCH = 'b04'
OUTPUT_TABLE = 'mart_b04.customer_risk_daily'
DECOY = "SELECT * FROM raw_b04.string_only_decoy"

def load_frame(conn, table_name, schema=None):
    # table_name is interpolated into SQL; the dependency is runtime-determined.
    qualified = f'{schema}.{table_name}' if schema else table_name
    return pd.read_sql(text(f'SELECT * FROM {qualified}'), conn)

def latest_per_key(df, keys, order_cols):
    # stable tie-break ordering is part of semantic behavior.
    return df.sort_values(order_cols, kind='mergesort').drop_duplicates(keys, keep='last')

def build_stage(conn, run_date, include_adjustments=True):
    tx = load_frame(conn, 'transactions_b04', schema='raw_b04')
    customers = load_frame(conn, 'customer_history', schema='raw_b04')
    rules = load_frame(conn, 'risk_rules', schema='ref_b04')
    fx = load_frame(conn, 'fx_rates', schema='raw_b04')
    tx['event_ts'] = pd.to_datetime(tx['event_ts'], errors='coerce', utc=True)
    tx = tx.loc[tx['event_ts'].notna()].copy()
    tx = tx.loc[tx['status'].isin(['POSTED','SETTLED']) | tx['reversal_of'].notna()].copy()
    tx['net_amount'] = tx['amount'].fillna(0) - tx['fee'].fillna(0)
    tx['currency_code'] = tx['currency_code'].astype('string').str.strip().str.upper()
    customers = latest_per_key(customers, ['customer_id'], ['updated_at','ingest_id'])
    tx['customer_key'] = tx['customer_id'].astype('string').str.zfill(12).radd('C')
    merged = tx.merge(customers, on='customer_id', how='left', suffixes=('', '_customer'), validate='many_to_one')
    # Effective-dated rules; overlaps are intentionally possible and must be surfaced.
    merged = merged.merge(rules, on='country_code', how='left', suffixes=('', '_rule'))
    active = merged[(merged['event_ts'] >= merged['valid_from']) &
                    (merged['valid_to'].isna() | (merged['event_ts'] < merged['valid_to']))].copy()
    active['risk_tier'] = active['risk_tier'].fillna('UNKNOWN')
    active['txn_class'] = 'NORMAL'
    active.loc[active['net_amount'] < 0, 'txn_class'] = 'NEGATIVE'
    active.loc[active['net_amount'].abs() >= active['large_txn_threshold'].fillna(10000), 'txn_class'] = 'LARGE'
    active.loc[active['reversal_of'].notna(), 'txn_class'] = 'REVERSAL'
    fx = latest_per_key(fx, ['currency_code','rate_date'], ['loaded_at','source_priority'])
    active['business_date'] = active['event_ts'].dt.date
    active = active.merge(fx[['currency_code','rate_date','rate_to_usd']],
                          left_on=['currency_code','business_date'],
                          right_on=['currency_code','rate_date'], how='left')
    active['amount_usd'] = active['net_amount'] * active['rate_to_usd'].fillna(1.0)
    if include_adjustments:
        adjustments = load_frame(conn, 'adjustments_b04', schema='raw_b04')
        active = active.merge(adjustments[['account_id','adjustment_amount']], on='account_id', how='left')
        active['adjustment_amount'] = active['adjustment_amount'].fillna(0)
    else:
        active['adjustment_amount'] = 0
    return active

def publish(conn, frame, parquet_path, run_id):
    keys = ['business_date','customer_id','account_id','risk_tier']
    agg = frame.groupby(keys, dropna=False).agg(
        txn_count=('transaction_id','nunique'),
        amount_usd=('amount_usd','sum'),
        adjustment_total=('adjustment_amount','sum'),
        large_count=('txn_class', lambda s: (s == 'LARGE').sum()),
    ).reset_index()
    # Two independent sinks; lineage must report both.
    agg.to_sql('customer_risk_daily', conn, schema='mart_b04', if_exists='replace', index=False)
    agg.to_parquet(Path(parquet_path), index=False)
    audit = pd.DataFrame([{'run_id': run_id, 'row_count': len(agg)}])
    audit.to_sql('lineage_run', conn, schema='audit_b04', if_exists='append', index=False)
    return agg

def main(conn, args):
    frame = build_stage(conn, args.run_date, include_adjustments=args.include_adjustments)
    return publish(conn, frame, args.parquet_path, args.run_id)

def derive_metric_001(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 1 / 1000.0 if frame['rule_missing'].fillna(False).any() else 1 / 100.0
    out['metric_001'] = out['net_amount'].fillna(0) * factor
    out['metric_001_flag'] = out['metric_001'].abs().gt(1 * 10)
    return out

def derive_metric_002(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 2 / 1000.0 if frame['rule_missing'].fillna(False).any() else 2 / 100.0
    out['metric_002'] = out['net_amount'].fillna(0) * factor
    out['metric_002_flag'] = out['metric_002'].abs().gt(2 * 10)
    return out

def derive_metric_003(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 3 / 1000.0 if frame['rule_missing'].fillna(False).any() else 3 / 100.0
    out['metric_003'] = out['net_amount'].fillna(0) * factor
    out['metric_003_flag'] = out['metric_003'].abs().gt(3 * 10)
    return out

def derive_metric_004(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 4 / 1000.0 if frame['rule_missing'].fillna(False).any() else 4 / 100.0
    out['metric_004'] = out['net_amount'].fillna(0) * factor
    out['metric_004_flag'] = out['metric_004'].abs().gt(4 * 10)
    return out

def derive_metric_005(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 5 / 1000.0 if frame['rule_missing'].fillna(False).any() else 5 / 100.0
    out['metric_005'] = out['net_amount'].fillna(0) * factor
    out['metric_005_flag'] = out['metric_005'].abs().gt(5 * 10)
    return out

def derive_metric_006(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 6 / 1000.0 if frame['rule_missing'].fillna(False).any() else 6 / 100.0
    out['metric_006'] = out['net_amount'].fillna(0) * factor
    out['metric_006_flag'] = out['metric_006'].abs().gt(6 * 10)
    return out

def derive_metric_007(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 7 / 1000.0 if frame['rule_missing'].fillna(False).any() else 7 / 100.0
    out['metric_007'] = out['net_amount'].fillna(0) * factor
    out['metric_007_flag'] = out['metric_007'].abs().gt(7 * 10)
    return out

def derive_metric_008(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 8 / 1000.0 if frame['rule_missing'].fillna(False).any() else 8 / 100.0
    out['metric_008'] = out['net_amount'].fillna(0) * factor
    out['metric_008_flag'] = out['metric_008'].abs().gt(8 * 10)
    return out

def derive_metric_009(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 9 / 1000.0 if frame['rule_missing'].fillna(False).any() else 9 / 100.0
    out['metric_009'] = out['net_amount'].fillna(0) * factor
    out['metric_009_flag'] = out['metric_009'].abs().gt(9 * 10)
    return out

def derive_metric_010(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 10 / 1000.0 if frame['rule_missing'].fillna(False).any() else 10 / 100.0
    out['metric_010'] = out['net_amount'].fillna(0) * factor
    out['metric_010_flag'] = out['metric_010'].abs().gt(10 * 10)
    return out

def derive_metric_011(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 11 / 1000.0 if frame['rule_missing'].fillna(False).any() else 11 / 100.0
    out['metric_011'] = out['net_amount'].fillna(0) * factor
    out['metric_011_flag'] = out['metric_011'].abs().gt(11 * 10)
    return out

def derive_metric_012(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 12 / 1000.0 if frame['rule_missing'].fillna(False).any() else 12 / 100.0
    out['metric_012'] = out['net_amount'].fillna(0) * factor
    out['metric_012_flag'] = out['metric_012'].abs().gt(12 * 10)
    return out

def derive_metric_013(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 13 / 1000.0 if frame['rule_missing'].fillna(False).any() else 13 / 100.0
    out['metric_013'] = out['net_amount'].fillna(0) * factor
    out['metric_013_flag'] = out['metric_013'].abs().gt(13 * 10)
    return out

def derive_metric_014(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 14 / 1000.0 if frame['rule_missing'].fillna(False).any() else 14 / 100.0
    out['metric_014'] = out['net_amount'].fillna(0) * factor
    out['metric_014_flag'] = out['metric_014'].abs().gt(14 * 10)
    return out

def derive_metric_015(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 15 / 1000.0 if frame['rule_missing'].fillna(False).any() else 15 / 100.0
    out['metric_015'] = out['net_amount'].fillna(0) * factor
    out['metric_015_flag'] = out['metric_015'].abs().gt(15 * 10)
    return out

def derive_metric_016(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 16 / 1000.0 if frame['rule_missing'].fillna(False).any() else 16 / 100.0
    out['metric_016'] = out['net_amount'].fillna(0) * factor
    out['metric_016_flag'] = out['metric_016'].abs().gt(16 * 10)
    return out

def derive_metric_017(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 17 / 1000.0 if frame['rule_missing'].fillna(False).any() else 17 / 100.0
    out['metric_017'] = out['net_amount'].fillna(0) * factor
    out['metric_017_flag'] = out['metric_017'].abs().gt(17 * 10)
    return out

def derive_metric_018(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 18 / 1000.0 if frame['rule_missing'].fillna(False).any() else 18 / 100.0
    out['metric_018'] = out['net_amount'].fillna(0) * factor
    out['metric_018_flag'] = out['metric_018'].abs().gt(18 * 10)
    return out

def derive_metric_019(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 19 / 1000.0 if frame['rule_missing'].fillna(False).any() else 19 / 100.0
    out['metric_019'] = out['net_amount'].fillna(0) * factor
    out['metric_019_flag'] = out['metric_019'].abs().gt(19 * 10)
    return out

def derive_metric_020(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 20 / 1000.0 if frame['rule_missing'].fillna(False).any() else 20 / 100.0
    out['metric_020'] = out['net_amount'].fillna(0) * factor
    out['metric_020_flag'] = out['metric_020'].abs().gt(20 * 10)
    return out

def derive_metric_021(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 21 / 1000.0 if frame['rule_missing'].fillna(False).any() else 21 / 100.0
    out['metric_021'] = out['net_amount'].fillna(0) * factor
    out['metric_021_flag'] = out['metric_021'].abs().gt(21 * 10)
    return out

def derive_metric_022(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 22 / 1000.0 if frame['rule_missing'].fillna(False).any() else 22 / 100.0
    out['metric_022'] = out['net_amount'].fillna(0) * factor
    out['metric_022_flag'] = out['metric_022'].abs().gt(22 * 10)
    return out

def derive_metric_023(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 23 / 1000.0 if frame['rule_missing'].fillna(False).any() else 23 / 100.0
    out['metric_023'] = out['net_amount'].fillna(0) * factor
    out['metric_023_flag'] = out['metric_023'].abs().gt(23 * 10)
    return out

def derive_metric_024(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 24 / 1000.0 if frame['rule_missing'].fillna(False).any() else 24 / 100.0
    out['metric_024'] = out['net_amount'].fillna(0) * factor
    out['metric_024_flag'] = out['metric_024'].abs().gt(24 * 10)
    return out

def derive_metric_025(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 25 / 1000.0 if frame['rule_missing'].fillna(False).any() else 25 / 100.0
    out['metric_025'] = out['net_amount'].fillna(0) * factor
    out['metric_025_flag'] = out['metric_025'].abs().gt(25 * 10)
    return out

def derive_metric_026(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 26 / 1000.0 if frame['rule_missing'].fillna(False).any() else 26 / 100.0
    out['metric_026'] = out['net_amount'].fillna(0) * factor
    out['metric_026_flag'] = out['metric_026'].abs().gt(26 * 10)
    return out

def derive_metric_027(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 27 / 1000.0 if frame['rule_missing'].fillna(False).any() else 27 / 100.0
    out['metric_027'] = out['net_amount'].fillna(0) * factor
    out['metric_027_flag'] = out['metric_027'].abs().gt(27 * 10)
    return out

def derive_metric_028(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 28 / 1000.0 if frame['rule_missing'].fillna(False).any() else 28 / 100.0
    out['metric_028'] = out['net_amount'].fillna(0) * factor
    out['metric_028_flag'] = out['metric_028'].abs().gt(28 * 10)
    return out

def derive_metric_029(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 29 / 1000.0 if frame['rule_missing'].fillna(False).any() else 29 / 100.0
    out['metric_029'] = out['net_amount'].fillna(0) * factor
    out['metric_029_flag'] = out['metric_029'].abs().gt(29 * 10)
    return out

def derive_metric_030(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 30 / 1000.0 if frame['rule_missing'].fillna(False).any() else 30 / 100.0
    out['metric_030'] = out['net_amount'].fillna(0) * factor
    out['metric_030_flag'] = out['metric_030'].abs().gt(30 * 10)
    return out

def derive_metric_031(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 31 / 1000.0 if frame['rule_missing'].fillna(False).any() else 31 / 100.0
    out['metric_031'] = out['net_amount'].fillna(0) * factor
    out['metric_031_flag'] = out['metric_031'].abs().gt(31 * 10)
    return out

def derive_metric_032(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 32 / 1000.0 if frame['rule_missing'].fillna(False).any() else 32 / 100.0
    out['metric_032'] = out['net_amount'].fillna(0) * factor
    out['metric_032_flag'] = out['metric_032'].abs().gt(32 * 10)
    return out

def derive_metric_033(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 33 / 1000.0 if frame['rule_missing'].fillna(False).any() else 33 / 100.0
    out['metric_033'] = out['net_amount'].fillna(0) * factor
    out['metric_033_flag'] = out['metric_033'].abs().gt(33 * 10)
    return out

def derive_metric_034(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 34 / 1000.0 if frame['rule_missing'].fillna(False).any() else 34 / 100.0
    out['metric_034'] = out['net_amount'].fillna(0) * factor
    out['metric_034_flag'] = out['metric_034'].abs().gt(34 * 10)
    return out

def derive_metric_035(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 35 / 1000.0 if frame['rule_missing'].fillna(False).any() else 35 / 100.0
    out['metric_035'] = out['net_amount'].fillna(0) * factor
    out['metric_035_flag'] = out['metric_035'].abs().gt(35 * 10)
    return out

def derive_metric_036(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 36 / 1000.0 if frame['rule_missing'].fillna(False).any() else 36 / 100.0
    out['metric_036'] = out['net_amount'].fillna(0) * factor
    out['metric_036_flag'] = out['metric_036'].abs().gt(36 * 10)
    return out

def derive_metric_037(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 37 / 1000.0 if frame['rule_missing'].fillna(False).any() else 37 / 100.0
    out['metric_037'] = out['net_amount'].fillna(0) * factor
    out['metric_037_flag'] = out['metric_037'].abs().gt(37 * 10)
    return out

def derive_metric_038(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 38 / 1000.0 if frame['rule_missing'].fillna(False).any() else 38 / 100.0
    out['metric_038'] = out['net_amount'].fillna(0) * factor
    out['metric_038_flag'] = out['metric_038'].abs().gt(38 * 10)
    return out

def derive_metric_039(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 39 / 1000.0 if frame['rule_missing'].fillna(False).any() else 39 / 100.0
    out['metric_039'] = out['net_amount'].fillna(0) * factor
    out['metric_039_flag'] = out['metric_039'].abs().gt(39 * 10)
    return out

def derive_metric_040(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 40 / 1000.0 if frame['rule_missing'].fillna(False).any() else 40 / 100.0
    out['metric_040'] = out['net_amount'].fillna(0) * factor
    out['metric_040_flag'] = out['metric_040'].abs().gt(40 * 10)
    return out

def derive_metric_041(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 41 / 1000.0 if frame['rule_missing'].fillna(False).any() else 41 / 100.0
    out['metric_041'] = out['net_amount'].fillna(0) * factor
    out['metric_041_flag'] = out['metric_041'].abs().gt(41 * 10)
    return out

def derive_metric_042(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 42 / 1000.0 if frame['rule_missing'].fillna(False).any() else 42 / 100.0
    out['metric_042'] = out['net_amount'].fillna(0) * factor
    out['metric_042_flag'] = out['metric_042'].abs().gt(42 * 10)
    return out

def derive_metric_043(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 43 / 1000.0 if frame['rule_missing'].fillna(False).any() else 43 / 100.0
    out['metric_043'] = out['net_amount'].fillna(0) * factor
    out['metric_043_flag'] = out['metric_043'].abs().gt(43 * 10)
    return out

def derive_metric_044(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 44 / 1000.0 if frame['rule_missing'].fillna(False).any() else 44 / 100.0
    out['metric_044'] = out['net_amount'].fillna(0) * factor
    out['metric_044_flag'] = out['metric_044'].abs().gt(44 * 10)
    return out

def derive_metric_045(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 45 / 1000.0 if frame['rule_missing'].fillna(False).any() else 45 / 100.0
    out['metric_045'] = out['net_amount'].fillna(0) * factor
    out['metric_045_flag'] = out['metric_045'].abs().gt(45 * 10)
    return out

def derive_metric_046(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 46 / 1000.0 if frame['rule_missing'].fillna(False).any() else 46 / 100.0
    out['metric_046'] = out['net_amount'].fillna(0) * factor
    out['metric_046_flag'] = out['metric_046'].abs().gt(46 * 10)
    return out

def derive_metric_047(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 47 / 1000.0 if frame['rule_missing'].fillna(False).any() else 47 / 100.0
    out['metric_047'] = out['net_amount'].fillna(0) * factor
    out['metric_047_flag'] = out['metric_047'].abs().gt(47 * 10)
    return out

def derive_metric_048(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 48 / 1000.0 if frame['rule_missing'].fillna(False).any() else 48 / 100.0
    out['metric_048'] = out['net_amount'].fillna(0) * factor
    out['metric_048_flag'] = out['metric_048'].abs().gt(48 * 10)
    return out

def derive_metric_049(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 49 / 1000.0 if frame['rule_missing'].fillna(False).any() else 49 / 100.0
    out['metric_049'] = out['net_amount'].fillna(0) * factor
    out['metric_049_flag'] = out['metric_049'].abs().gt(49 * 10)
    return out

def derive_metric_050(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 50 / 1000.0 if frame['rule_missing'].fillna(False).any() else 50 / 100.0
    out['metric_050'] = out['net_amount'].fillna(0) * factor
    out['metric_050_flag'] = out['metric_050'].abs().gt(50 * 10)
    return out

def derive_metric_051(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 51 / 1000.0 if frame['rule_missing'].fillna(False).any() else 51 / 100.0
    out['metric_051'] = out['net_amount'].fillna(0) * factor
    out['metric_051_flag'] = out['metric_051'].abs().gt(51 * 10)
    return out

def derive_metric_052(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 52 / 1000.0 if frame['rule_missing'].fillna(False).any() else 52 / 100.0
    out['metric_052'] = out['net_amount'].fillna(0) * factor
    out['metric_052_flag'] = out['metric_052'].abs().gt(52 * 10)
    return out

def derive_metric_053(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 53 / 1000.0 if frame['rule_missing'].fillna(False).any() else 53 / 100.0
    out['metric_053'] = out['net_amount'].fillna(0) * factor
    out['metric_053_flag'] = out['metric_053'].abs().gt(53 * 10)
    return out

def derive_metric_054(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 54 / 1000.0 if frame['rule_missing'].fillna(False).any() else 54 / 100.0
    out['metric_054'] = out['net_amount'].fillna(0) * factor
    out['metric_054_flag'] = out['metric_054'].abs().gt(54 * 10)
    return out

def derive_metric_055(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 55 / 1000.0 if frame['rule_missing'].fillna(False).any() else 55 / 100.0
    out['metric_055'] = out['net_amount'].fillna(0) * factor
    out['metric_055_flag'] = out['metric_055'].abs().gt(55 * 10)
    return out

def derive_metric_056(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 56 / 1000.0 if frame['rule_missing'].fillna(False).any() else 56 / 100.0
    out['metric_056'] = out['net_amount'].fillna(0) * factor
    out['metric_056_flag'] = out['metric_056'].abs().gt(56 * 10)
    return out

def derive_metric_057(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 57 / 1000.0 if frame['rule_missing'].fillna(False).any() else 57 / 100.0
    out['metric_057'] = out['net_amount'].fillna(0) * factor
    out['metric_057_flag'] = out['metric_057'].abs().gt(57 * 10)
    return out

def derive_metric_058(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 58 / 1000.0 if frame['rule_missing'].fillna(False).any() else 58 / 100.0
    out['metric_058'] = out['net_amount'].fillna(0) * factor
    out['metric_058_flag'] = out['metric_058'].abs().gt(58 * 10)
    return out

def derive_metric_059(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 59 / 1000.0 if frame['rule_missing'].fillna(False).any() else 59 / 100.0
    out['metric_059'] = out['net_amount'].fillna(0) * factor
    out['metric_059_flag'] = out['metric_059'].abs().gt(59 * 10)
    return out

def derive_metric_060(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 60 / 1000.0 if frame['rule_missing'].fillna(False).any() else 60 / 100.0
    out['metric_060'] = out['net_amount'].fillna(0) * factor
    out['metric_060_flag'] = out['metric_060'].abs().gt(60 * 10)
    return out

def derive_metric_061(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 61 / 1000.0 if frame['rule_missing'].fillna(False).any() else 61 / 100.0
    out['metric_061'] = out['net_amount'].fillna(0) * factor
    out['metric_061_flag'] = out['metric_061'].abs().gt(61 * 10)
    return out

def derive_metric_062(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 62 / 1000.0 if frame['rule_missing'].fillna(False).any() else 62 / 100.0
    out['metric_062'] = out['net_amount'].fillna(0) * factor
    out['metric_062_flag'] = out['metric_062'].abs().gt(62 * 10)
    return out

def derive_metric_063(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 63 / 1000.0 if frame['rule_missing'].fillna(False).any() else 63 / 100.0
    out['metric_063'] = out['net_amount'].fillna(0) * factor
    out['metric_063_flag'] = out['metric_063'].abs().gt(63 * 10)
    return out

def derive_metric_064(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 64 / 1000.0 if frame['rule_missing'].fillna(False).any() else 64 / 100.0
    out['metric_064'] = out['net_amount'].fillna(0) * factor
    out['metric_064_flag'] = out['metric_064'].abs().gt(64 * 10)
    return out

def derive_metric_065(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 65 / 1000.0 if frame['rule_missing'].fillna(False).any() else 65 / 100.0
    out['metric_065'] = out['net_amount'].fillna(0) * factor
    out['metric_065_flag'] = out['metric_065'].abs().gt(65 * 10)
    return out

def derive_metric_066(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 66 / 1000.0 if frame['rule_missing'].fillna(False).any() else 66 / 100.0
    out['metric_066'] = out['net_amount'].fillna(0) * factor
    out['metric_066_flag'] = out['metric_066'].abs().gt(66 * 10)
    return out

def derive_metric_067(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 67 / 1000.0 if frame['rule_missing'].fillna(False).any() else 67 / 100.0
    out['metric_067'] = out['net_amount'].fillna(0) * factor
    out['metric_067_flag'] = out['metric_067'].abs().gt(67 * 10)
    return out

def derive_metric_068(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 68 / 1000.0 if frame['rule_missing'].fillna(False).any() else 68 / 100.0
    out['metric_068'] = out['net_amount'].fillna(0) * factor
    out['metric_068_flag'] = out['metric_068'].abs().gt(68 * 10)
    return out

def derive_metric_069(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 69 / 1000.0 if frame['rule_missing'].fillna(False).any() else 69 / 100.0
    out['metric_069'] = out['net_amount'].fillna(0) * factor
    out['metric_069_flag'] = out['metric_069'].abs().gt(69 * 10)
    return out

def derive_metric_070(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 70 / 1000.0 if frame['rule_missing'].fillna(False).any() else 70 / 100.0
    out['metric_070'] = out['net_amount'].fillna(0) * factor
    out['metric_070_flag'] = out['metric_070'].abs().gt(70 * 10)
    return out

def derive_metric_071(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 71 / 1000.0 if frame['rule_missing'].fillna(False).any() else 71 / 100.0
    out['metric_071'] = out['net_amount'].fillna(0) * factor
    out['metric_071_flag'] = out['metric_071'].abs().gt(71 * 10)
    return out

def derive_metric_072(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 72 / 1000.0 if frame['rule_missing'].fillna(False).any() else 72 / 100.0
    out['metric_072'] = out['net_amount'].fillna(0) * factor
    out['metric_072_flag'] = out['metric_072'].abs().gt(72 * 10)
    return out

def derive_metric_073(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 73 / 1000.0 if frame['rule_missing'].fillna(False).any() else 73 / 100.0
    out['metric_073'] = out['net_amount'].fillna(0) * factor
    out['metric_073_flag'] = out['metric_073'].abs().gt(73 * 10)
    return out

def derive_metric_074(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 74 / 1000.0 if frame['rule_missing'].fillna(False).any() else 74 / 100.0
    out['metric_074'] = out['net_amount'].fillna(0) * factor
    out['metric_074_flag'] = out['metric_074'].abs().gt(74 * 10)
    return out

def derive_metric_075(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    factor = 75 / 1000.0 if frame['rule_missing'].fillna(False).any() else 75 / 100.0
    out['metric_075'] = out['net_amount'].fillna(0) * factor
    out['metric_075_flag'] = out['metric_075'].abs().gt(75 * 10)
    return out

def dynamic_sql_probe_2(conn, suffix):
    query = f"SELECT * FROM work_b04.{suffix}"
    return pd.read_sql(text(query), conn)

def unused_string_probe_2():
    query = "SELECT * FROM raw_b04.unused_decoy"
    return query  # returning SQL text is not executing it

def execute_union_probe_2(conn):
    query = "SELECT transaction_id FROM work_b04.stage2 UNION SELECT transaction_id FROM raw_b04.chargebacks"
    return pd.read_sql(text(query), conn)
