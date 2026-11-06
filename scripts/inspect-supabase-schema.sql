-- Metadata only. Never execute a supplied query or read application rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT json_build_object(
  'kind','catalog',
  'readOnly',current_setting('transaction_read_only') = 'on',
  'database',current_database(),
  'tableLimitReached',(SELECT count(*) > 100 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')),
  'tables',COALESCE((SELECT json_agg(row_to_json(t)) FROM (
    SELECT c.relname AS name,c.relrowsecurity AS "rlsEnabled",c.relforcerowsecurity AS "rlsForced",
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS "columnCount",
      COALESCE((SELECT json_agg(row_to_json(a)) FROM (
        SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull"
        FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 100
      ) a),'[]'::json) AS columns,
      (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS "policyCount",
      COALESCE((SELECT json_agg(row_to_json(p)) FROM (
        SELECT policyname AS name,roles,cmd,permissive,left(qual,2000) AS "using",left(with_check,2000) AS "withCheck",
          COALESCE(length(qual)>2000 OR length(with_check)>2000,false) AS truncated
        FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname ORDER BY policyname LIMIT 20
      ) p),'[]'::json) AS policies,
      (SELECT count(*) FROM pg_indexes i WHERE i.schemaname='public' AND i.tablename=c.relname) AS "indexCount",
      COALESCE((SELECT json_agg(row_to_json(i)) FROM (
        SELECT indexname AS name,left(indexdef,2000) AS definition,length(indexdef)>2000 AS truncated
        FROM pg_indexes i WHERE i.schemaname='public' AND i.tablename=c.relname ORDER BY indexname LIMIT 20
      ) i),'[]'::json) AS indexes,
      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=c.oid) AS "constraintCount",
      COALESCE((SELECT json_agg(row_to_json(k)) FROM (
        SELECT conname AS name,contype AS type,left(pg_get_constraintdef(oid),2000) AS definition,
          length(pg_get_constraintdef(oid))>2000 AS truncated
        FROM pg_constraint k WHERE k.conrelid=c.oid ORDER BY conname LIMIT 20
      ) k),'[]'::json) AS constraints,
      (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal) AS "triggerCount",
      COALESCE((SELECT json_agg(row_to_json(g)) FROM (
        SELECT tgname AS name,left(pg_get_triggerdef(oid),2000) AS definition,
          length(pg_get_triggerdef(oid))>2000 AS truncated
        FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal ORDER BY tgname LIMIT 20
      ) g),'[]'::json) AS triggers
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname LIMIT 100
  ) t),'[]'::json)
);
SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS migration_table_exists \gset
\if :migration_table_exists
SELECT json_build_object('kind','migration','present',EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261102050000'));
\else
SELECT '{"kind":"migration","present":null}'::json;
\endif
ROLLBACK;
