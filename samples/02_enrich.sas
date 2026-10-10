/* Stage 2 - enrich staging data into analytical base tables (SAS).
   Reads the stg_* datasets produced by the Python ingest step and builds the
   customer_accounts, txn_summary and collateral_clean datasets consumed by the
   SQL regulatory layer. */

libname stg "/data/staging";
libname mart "/data/mart";

/* Merge customers and their accounts into one base table. */
data mart.customer_accounts;
    merge stg.stg_customers (in=c)
          stg.stg_accounts   (in=a);
    by customer_id;
    if c and a;
run;

/* Clean and sort collateral records. */
proc sort data=stg.stg_collateral out=mart.collateral_clean nodupkey;
    by account_id;
run;

/* Aggregate transactions to account level using PROC SQL. */
proc sql;
    create table mart.txn_summary as
    select account_id,
           count(*)          as txn_count,
           sum(amount_eur)   as total_amount_eur
    from stg.stg_transactions
    group by account_id;
quit;
