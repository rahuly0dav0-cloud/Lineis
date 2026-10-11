-- Stress fixture b04 stage 3; PostgreSQL-like SQL with deliberately difficult lineage.
BEGIN;
CREATE TEMP TABLE b04_params AS
SELECT DATE '2025-01-01' AS from_dt, DATE '2025-12-31' AS to_dt, 0.025::numeric AS tolerance;
CREATE TEMP TABLE b04_base AS
WITH RECURSIVE calendar(d) AS (
  SELECT (SELECT from_dt FROM b04_params)
  UNION ALL
  SELECT d + 1 FROM calendar, b04_params WHERE d < to_dt
), latest_customer AS (
  SELECT DISTINCT ON (customer_id) customer_id, segment, country_code, updated_at
  FROM raw_b04.customer_history
  WHERE is_deleted IS DISTINCT FROM TRUE
  ORDER BY customer_id, updated_at DESC NULLS LAST, ingest_id DESC
), tx AS (
  SELECT t.transaction_id, t.customer_id, t.account_id, t.event_ts, t.posted_ts,
         COALESCE(t.amount, 0) - COALESCE(t.fee, 0) AS net_amount,
         NULLIF(UPPER(TRIM(t.currency_code)), '') AS currency_code,
         t.status, t.reversal_of, t.payload ->> 'channel' AS channel
  FROM raw_b04.transactions t
  CROSS JOIN b04_params prm
  WHERE t.event_ts >= prm.from_dt::timestamp
    AND t.event_ts < (prm.to_dt + INTERVAL '1 day')::timestamp
    AND (t.status IN ('POSTED','SETTLED') OR t.reversal_of IS NOT NULL)
), dedup AS (
  SELECT * FROM (
    SELECT tx.*, ROW_NUMBER() OVER (PARTITION BY transaction_id ORDER BY posted_ts DESC NULLS LAST) AS rn
    FROM tx
  ) q WHERE rn = 1
)
SELECT d.*, c.segment, c.country_code, cal.d AS calendar_date
FROM dedup d LEFT JOIN latest_customer c ON c.customer_id = d.customer_id
LEFT JOIN calendar cal ON cal.d = d.event_ts::date;
CREATE TEMP TABLE b04_rules_applied AS
SELECT b.*,
       COALESCE(r.risk_tier, 'UNKNOWN') AS risk_tier,
       CASE WHEN b.reversal_of IS NOT NULL THEN 'REVERSAL'
            WHEN ABS(b.net_amount) >= COALESCE(r.large_txn_threshold, 10000) THEN 'LARGE'
            WHEN b.net_amount < 0 THEN 'NEGATIVE'
            ELSE 'NORMAL' END AS txn_class,
       CASE WHEN r.rule_id IS NULL THEN TRUE ELSE FALSE END AS rule_missing
FROM b04_base b
LEFT JOIN ref_b04.risk_rules r
  ON r.country_code IS NOT DISTINCT FROM b.country_code
 AND b.event_ts >= r.valid_from
 AND (b.event_ts < r.valid_to OR r.valid_to IS NULL)
 AND (r.segment IS NULL OR r.segment = b.segment);
CREATE TABLE work_b04.stage3 AS
SELECT * FROM b04_rules_applied;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_001 numeric;
UPDATE work_b04.stage3
SET metric_001 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (1::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (1::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (1::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (1::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_002 numeric;
UPDATE work_b04.stage3
SET metric_002 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (2::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (2::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (2::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (2::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_003 numeric;
UPDATE work_b04.stage3
SET metric_003 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (3::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (3::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (3::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (3::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_004 numeric;
UPDATE work_b04.stage3
SET metric_004 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (4::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (4::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (4::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (4::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_005 numeric;
UPDATE work_b04.stage3
SET metric_005 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (5::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (5::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (5::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (5::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_006 numeric;
UPDATE work_b04.stage3
SET metric_006 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (6::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (6::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (6::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (6::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_007 numeric;
UPDATE work_b04.stage3
SET metric_007 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (7::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (7::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (7::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (7::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_008 numeric;
UPDATE work_b04.stage3
SET metric_008 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (8::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (8::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (8::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (8::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_009 numeric;
UPDATE work_b04.stage3
SET metric_009 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (9::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (9::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (9::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (9::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_010 numeric;
UPDATE work_b04.stage3
SET metric_010 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (10::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (10::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (10::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (10::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_011 numeric;
UPDATE work_b04.stage3
SET metric_011 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (11::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (11::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (11::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (11::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_012 numeric;
UPDATE work_b04.stage3
SET metric_012 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (12::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (12::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (12::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (12::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_013 numeric;
UPDATE work_b04.stage3
SET metric_013 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (13::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (13::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (13::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (13::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_014 numeric;
UPDATE work_b04.stage3
SET metric_014 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (14::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (14::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (14::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (14::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_015 numeric;
UPDATE work_b04.stage3
SET metric_015 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (15::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (15::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (15::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (15::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_016 numeric;
UPDATE work_b04.stage3
SET metric_016 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (16::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (16::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (16::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (16::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_017 numeric;
UPDATE work_b04.stage3
SET metric_017 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (17::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (17::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (17::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (17::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_018 numeric;
UPDATE work_b04.stage3
SET metric_018 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (18::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (18::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (18::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (18::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_019 numeric;
UPDATE work_b04.stage3
SET metric_019 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (19::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (19::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (19::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (19::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_020 numeric;
UPDATE work_b04.stage3
SET metric_020 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (20::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (20::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (20::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (20::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_021 numeric;
UPDATE work_b04.stage3
SET metric_021 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (21::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (21::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (21::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (21::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_022 numeric;
UPDATE work_b04.stage3
SET metric_022 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (22::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (22::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (22::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (22::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_023 numeric;
UPDATE work_b04.stage3
SET metric_023 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (23::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (23::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (23::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (23::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_024 numeric;
UPDATE work_b04.stage3
SET metric_024 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (24::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (24::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (24::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (24::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_025 numeric;
UPDATE work_b04.stage3
SET metric_025 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (25::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (25::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (25::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (25::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_026 numeric;
UPDATE work_b04.stage3
SET metric_026 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (26::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (26::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (26::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (26::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_027 numeric;
UPDATE work_b04.stage3
SET metric_027 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (27::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (27::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (27::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (27::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_028 numeric;
UPDATE work_b04.stage3
SET metric_028 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (28::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (28::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (28::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (28::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_029 numeric;
UPDATE work_b04.stage3
SET metric_029 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (29::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (29::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (29::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (29::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_030 numeric;
UPDATE work_b04.stage3
SET metric_030 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (30::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (30::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (30::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (30::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_031 numeric;
UPDATE work_b04.stage3
SET metric_031 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (31::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (31::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (31::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (31::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_032 numeric;
UPDATE work_b04.stage3
SET metric_032 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (32::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (32::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (32::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (32::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_033 numeric;
UPDATE work_b04.stage3
SET metric_033 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (33::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (33::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (33::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (33::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_034 numeric;
UPDATE work_b04.stage3
SET metric_034 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (34::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (34::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (34::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (34::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_035 numeric;
UPDATE work_b04.stage3
SET metric_035 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (35::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (35::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (35::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (35::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_036 numeric;
UPDATE work_b04.stage3
SET metric_036 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (36::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (36::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (36::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (36::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_037 numeric;
UPDATE work_b04.stage3
SET metric_037 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (37::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (37::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (37::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (37::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_038 numeric;
UPDATE work_b04.stage3
SET metric_038 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (38::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (38::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (38::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (38::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_039 numeric;
UPDATE work_b04.stage3
SET metric_039 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (39::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (39::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (39::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (39::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_040 numeric;
UPDATE work_b04.stage3
SET metric_040 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (40::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (40::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (40::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (40::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_041 numeric;
UPDATE work_b04.stage3
SET metric_041 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (41::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (41::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (41::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (41::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_042 numeric;
UPDATE work_b04.stage3
SET metric_042 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (42::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (42::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (42::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (42::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_043 numeric;
UPDATE work_b04.stage3
SET metric_043 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (43::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (43::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (43::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (43::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_044 numeric;
UPDATE work_b04.stage3
SET metric_044 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (44::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (44::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (44::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (44::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_045 numeric;
UPDATE work_b04.stage3
SET metric_045 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (45::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (45::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (45::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (45::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_046 numeric;
UPDATE work_b04.stage3
SET metric_046 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (46::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (46::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (46::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (46::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_047 numeric;
UPDATE work_b04.stage3
SET metric_047 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (47::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (47::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (47::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (47::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_048 numeric;
UPDATE work_b04.stage3
SET metric_048 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (48::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (48::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (48::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (48::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_049 numeric;
UPDATE work_b04.stage3
SET metric_049 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (49::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (49::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (49::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (49::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_050 numeric;
UPDATE work_b04.stage3
SET metric_050 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (50::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (50::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (50::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (50::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_051 numeric;
UPDATE work_b04.stage3
SET metric_051 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (51::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (51::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (51::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (51::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_052 numeric;
UPDATE work_b04.stage3
SET metric_052 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (52::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (52::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (52::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (52::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_053 numeric;
UPDATE work_b04.stage3
SET metric_053 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (53::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (53::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (53::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (53::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_054 numeric;
UPDATE work_b04.stage3
SET metric_054 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (54::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (54::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (54::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (54::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_055 numeric;
UPDATE work_b04.stage3
SET metric_055 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (55::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (55::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (55::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (55::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_056 numeric;
UPDATE work_b04.stage3
SET metric_056 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (56::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (56::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (56::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (56::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_057 numeric;
UPDATE work_b04.stage3
SET metric_057 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (57::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (57::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (57::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (57::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_058 numeric;
UPDATE work_b04.stage3
SET metric_058 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (58::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (58::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (58::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (58::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_059 numeric;
UPDATE work_b04.stage3
SET metric_059 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (59::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (59::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (59::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (59::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_060 numeric;
UPDATE work_b04.stage3
SET metric_060 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (60::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (60::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (60::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (60::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_061 numeric;
UPDATE work_b04.stage3
SET metric_061 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (61::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (61::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (61::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (61::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_062 numeric;
UPDATE work_b04.stage3
SET metric_062 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (62::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (62::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (62::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (62::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_063 numeric;
UPDATE work_b04.stage3
SET metric_063 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (63::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (63::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (63::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (63::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_064 numeric;
UPDATE work_b04.stage3
SET metric_064 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (64::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (64::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (64::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (64::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_065 numeric;
UPDATE work_b04.stage3
SET metric_065 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (65::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (65::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (65::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (65::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_066 numeric;
UPDATE work_b04.stage3
SET metric_066 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (66::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (66::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (66::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (66::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_067 numeric;
UPDATE work_b04.stage3
SET metric_067 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (67::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (67::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (67::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (67::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_068 numeric;
UPDATE work_b04.stage3
SET metric_068 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (68::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (68::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (68::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (68::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_069 numeric;
UPDATE work_b04.stage3
SET metric_069 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (69::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (69::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (69::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (69::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_070 numeric;
UPDATE work_b04.stage3
SET metric_070 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (70::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (70::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (70::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (70::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_071 numeric;
UPDATE work_b04.stage3
SET metric_071 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (71::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (71::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (71::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (71::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_072 numeric;
UPDATE work_b04.stage3
SET metric_072 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (72::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (72::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (72::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (72::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_073 numeric;
UPDATE work_b04.stage3
SET metric_073 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (73::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (73::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (73::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (73::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_074 numeric;
UPDATE work_b04.stage3
SET metric_074 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (74::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (74::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (74::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (74::numeric / 10000) END;
ALTER TABLE work_b04.stage3 ADD COLUMN IF NOT EXISTS metric_075 numeric;
UPDATE work_b04.stage3
SET metric_075 = CASE
  WHEN txn_class = 'REVERSAL' THEN -1 * ABS(net_amount) * (75::numeric / 100)
  WHEN txn_class = 'LARGE' THEN COALESCE(net_amount, 0) * (75::numeric / 100)
  WHEN rule_missing THEN COALESCE(net_amount, 0) * (75::numeric / 1000)
  ELSE COALESCE(net_amount, 0) * (75::numeric / 10000) END;
CREATE TEMP TABLE b04_recon AS
SELECT 'TXN' AS row_type, transaction_id::text AS business_key, SUM(net_amount) AS amount FROM work_b04.stage3 GROUP BY transaction_id
UNION ALL
SELECT 'ADJUSTMENT', a.adjustment_id::text, SUM(a.adjustment_amount)
FROM raw_b04.adjustments a
WHERE EXISTS (SELECT 1 FROM work_b04.stage3 s WHERE s.account_id = a.account_id)
GROUP BY a.adjustment_id;
CREATE TEMP TABLE b04_fx AS
SELECT currency_code, rate_date, rate_to_usd FROM (
 SELECT f.*, ROW_NUMBER() OVER (PARTITION BY currency_code, rate_date ORDER BY loaded_at DESC, source_priority DESC) AS rn
 FROM raw_b04.fx_rates f
) x WHERE rn = 1;
CREATE TABLE mart_b04.customer_risk_daily AS
SELECT s.event_ts::date AS business_date, s.customer_id, s.account_id, s.risk_tier,
       COUNT(DISTINCT s.transaction_id) AS txn_count,
       SUM(s.net_amount * COALESCE(f.rate_to_usd, 1)) AS amount_usd,
       SUM(CASE WHEN s.txn_class='LARGE' THEN 1 ELSE 0 END) AS large_count,
       SUM(s.metric_001) AS metric_001_sum, SUM(s.metric_075) AS metric_075_sum,
       (SELECT COUNT(*) FROM b04_recon r WHERE r.business_key = s.account_id::text) AS recon_count
FROM work_b04.stage3 s
LEFT JOIN b04_fx f ON f.currency_code=s.currency_code AND f.rate_date=s.event_ts::date
GROUP BY s.event_ts::date, s.customer_id, s.account_id, s.risk_tier;
INSERT INTO audit_b04.lineage_run(run_id, output_name, row_count)
SELECT current_setting('app.run_id', true), 'mart_b04.customer_risk_daily', COUNT(*) FROM mart_b04.customer_risk_daily;
COMMIT;
DO $$ BEGIN PERFORM 'b04.fake_table_not_read'; END $$;
CREATE TEMP TABLE b04_self_join_probe AS SELECT a.transaction_id, b.reversal_of
FROM work_b04.stage3 a JOIN work_b04.stage3 b ON a.transaction_id=b.reversal_of;
CREATE TEMP TABLE b04_union_probe AS SELECT transaction_id FROM work_b04.stage3
UNION SELECT transaction_id FROM raw_b04.chargebacks;
CREATE TEMP TABLE b04_lateral_probe AS SELECT s.transaction_id, x.flag
FROM work_b04.stage3 s CROSS JOIN LATERAL (SELECT s.net_amount > 0 AS flag) x;
CREATE TEMP TABLE b04_unused_cte_probe AS WITH unused AS (SELECT * FROM raw_b04.unused_decoy)
SELECT transaction_id FROM work_b04.stage3;
