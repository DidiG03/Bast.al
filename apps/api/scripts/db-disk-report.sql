-- Where the database's disk went. Read-only: run it with psql against the
-- production DATABASE_URL (Railway: the Postgres service > Data, or
-- `railway connect Postgres`), e.g.
--   psql "$DATABASE_URL" -f apps/api/scripts/db-disk-report.sql
-- The clean-up steps are at the end, commented out: read the report first.

\echo '== Database size'
SELECT current_database() AS database, pg_size_pretty(pg_database_size(current_database())) AS size;

\echo '== Largest tables (table, its indexes, and the total with TOAST)'
SELECT c.relname AS table,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows,
       s.last_autovacuum
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;

\echo '== Largest indexes'
SELECT indexrelname AS index, relname AS table, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan AS scans
FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 15;

\echo '== WAL kept on disk (needs superuser or pg_monitor; skip if refused)'
SELECT count(*) AS wal_files, pg_size_pretty(sum(size)) AS wal_size FROM pg_ls_waldir();

\echo '== Replication slots: an inactive slot keeps every WAL file since it stopped'
SELECT slot_name, slot_type, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_held
FROM pg_replication_slots;

\echo '== Temporary files written since the stats were reset (sorts and hashes that did not fit in work_mem)'
SELECT datname, temp_files, pg_size_pretty(temp_bytes) AS temp_written, stats_reset FROM pg_stat_database WHERE datname = current_database();
SHOW work_mem;
SHOW temp_file_limit;

\echo '== Queries writing the most temporary files (needs pg_stat_statements; skip if missing)'
SELECT left(query, 160) AS query, calls, pg_size_pretty(temp_blks_written * 8192) AS temp_written, round(mean_exec_time) AS mean_ms
FROM pg_stat_statements ORDER BY temp_blks_written DESC LIMIT 10;

\echo '== Rows the clean-up job would remove now'
SELECT 'odds_snapshots older than 7 days' AS what, count(*) FROM odds_snapshots WHERE recorded_at < now() - interval '7 days'
UNION ALL SELECT 'live_pauses older than 60 days', count(*) FROM live_pauses WHERE started_at < now() - interval '60 days'
UNION ALL SELECT 'early_goals older than 60 days', count(*) FROM early_goals WHERE seen_at < now() - interval '60 days'
UNION ALL SELECT 'goals_seen older than 30 days', count(*) FROM goals_seen WHERE seen_at < now() - interval '30 days';

-- == Clean-up, once the report shows where the space is ==
--
-- 1) An inactive replication slot holding WAL (nothing reads it any more):
--      SELECT pg_drop_replication_slot('<slot_name>');
--
-- 2) Old price history, in batches (repeat until it deletes 0 rows):
--      DELETE FROM odds_snapshots WHERE ctid IN (SELECT ctid FROM odds_snapshots WHERE recorded_at < now() - interval '7 days' LIMIT 50000);
--
-- 3) DELETE frees space for Postgres to reuse but doesn't shrink the files.
--    To give it back to the disk, once there's room (it needs about the
--    table's size free while it runs, and locks the table):
--      VACUUM (FULL, ANALYZE) odds_snapshots;
--    Without that room, a plain VACUUM ANALYZE makes the space reusable:
--      VACUUM ANALYZE odds_snapshots;
