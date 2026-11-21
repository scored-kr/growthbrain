-- Growth Brain: run this entire SELECT in the target project's Supabase SQL Editor.
-- No role setup, customer rows, function bodies, defaults, policy literals or credentials.
-- Returns one JSON cell. Check object names before sharing (names are project metadata).
WITH api_roles AS (
  SELECT r.oid, r.rolname FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
), relations AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
), selected AS (
  SELECT * FROM relations ORDER BY relname LIMIT 40
), rules AS (
  SELECT p.*, s.oid AS relation_id
  FROM pg_catalog.pg_policies p JOIN selected s ON s.relname = p.tablename
  WHERE p.schemaname = 'public'
), policy_terms AS (
  SELECT r.relation_id, r.policyname, t.kind,
    CASE
      WHEN t.expression IS NULL THEN NULL
      WHEN t.expression IN ('true','false') THEN t.expression
      -- Return only common owner comparisons with a real column of this table.
      -- All other SQL (including literals and custom predicates) stays in the Dashboard.
      WHEN EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = r.relation_id AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname ~ '^[a-z_][a-z_0-9]*$'
          AND regexp_replace(t.expression, '[[:space:]()]', '', 'g') IN (
            a.attname || '=auth.uid', 'auth.uid=' || a.attname,
            a.attname || '=SELECTauth.uidASuid', 'SELECTauth.uidASuid=' || a.attname
          )
      ) THEN left(t.expression, 240)
      ELSE '[review in Dashboard]'
    END AS shareable
  FROM rules r CROSS JOIN LATERAL (VALUES ('using',r.qual),('withCheck',r.with_check)) AS t(kind,expression)
), table_details AS (
  SELECT s.relname AS name, jsonb_build_object(
    'name',s.relname,'kind',s.relkind,'rls',s.relrowsecurity,'forceRls',s.relforcerowsecurity,
    'columnCount',(SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid=s.oid AND a.attnum>0 AND NOT a.attisdropped),
    'columns',coalesce((SELECT jsonb_agg(jsonb_build_array(a.attname,a.type_name,a.attnotnull) ORDER BY a.attnum)
      FROM (SELECT a.attname,a.attnum,a.attnotnull,pg_catalog.format_type(a.atttypid,NULL) AS type_name
            FROM pg_catalog.pg_attribute a WHERE a.attrelid=s.oid AND a.attnum>0 AND NOT a.attisdropped
            ORDER BY a.attnum LIMIT 32) a),'[]'),
    'policyCount',(SELECT count(*) FROM rules r WHERE r.relation_id=s.oid),
    'policies',coalesce((SELECT jsonb_agg(jsonb_build_object('name',r.policyname,'cmd',r.cmd,'mode',r.permissive,
      'roles',r.roles[1:12],'roleCount',cardinality(r.roles),'expression',
      (SELECT jsonb_object_agg(t.kind,t.shareable) FROM policy_terms t WHERE t.relation_id=s.oid AND t.policyname=r.policyname))
      ORDER BY r.policyname)
      FROM (SELECT * FROM rules r WHERE r.relation_id=s.oid ORDER BY r.policyname LIMIT 12) r),'[]'),
    'tablePrivileges',coalesce((SELECT jsonb_object_agg(r.rolname, (
      SELECT coalesce(jsonb_agg(p ORDER BY p),'[]') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE pg_catalog.has_table_privilege(r.oid,s.oid,p))) FROM api_roles r),'{}'),
    'anyColumnPrivileges',coalesce((SELECT jsonb_object_agg(r.rolname, (
      SELECT coalesce(jsonb_agg(p ORDER BY p),'[]') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p
      WHERE pg_catalog.has_any_column_privilege(r.oid,s.oid,p))) FROM api_roles r),'{}')
  ) AS detail FROM selected s
), routines AS (
  SELECT p.oid,p.proname,p.proargtypes,p.prorettype,p.prosecdef,p.pronargs
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
), routine_details AS (
  SELECT f.proname, f.oid, jsonb_build_object('name',f.proname,
    'inputTypes',coalesce((SELECT jsonb_agg(pg_catalog.format_type(x.id,NULL) ORDER BY x.pos)
      FROM unnest(f.proargtypes) WITH ORDINALITY x(id,pos) WHERE x.pos<=12),'[]'),
    'inputCount',f.pronargs,'returns',pg_catalog.format_type(f.prorettype,NULL),'securityDefiner',f.prosecdef,
    'execute',coalesce((SELECT jsonb_object_agg(r.rolname,pg_catalog.has_function_privilege(r.oid,f.oid,'EXECUTE')) FROM api_roles r),'{}')
  ) AS detail
  FROM (SELECT * FROM routines ORDER BY (proname LIKE 'growthbrain%') DESC,proname,oid LIMIT 40) f
), contract AS (
  SELECT name, pg_catalog.to_regprocedure(signature) IS NOT NULL AS present
  FROM (VALUES
    ('status','public.growthbrain_sync_v1_status()'),('read','public.growthbrain_sync_v1_read()'),
    ('write','public.growthbrain_sync_v1_write(uuid,jsonb)'),('purge','public.growthbrain_sync_v1_purge(uuid)')
  ) s(name,signature)
)
SELECT jsonb_build_object(
  'report','growthbrain-dashboard-inventory-v1','schema','public','applicationRowsRead',false,
  'apiRoles',coalesce((SELECT jsonb_agg(rolname ORDER BY rolname) FROM api_roles),'[]'),
  'relationCount',(SELECT count(*) FROM relations),
  'tables',coalesce((SELECT jsonb_agg(detail ORDER BY name) FROM table_details),'[]'),
  'publicFunctionCount',(SELECT count(*) FROM routines),
  'functions',coalesce((SELECT jsonb_agg(detail ORDER BY proname,oid) FROM routine_details),'[]'),
  'migration',jsonb_build_object('expected','20261102050000','historyTablePresent',
    pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL,
    'versionPresent',NULL,'reason','Migration rows were not queried.'),
  'syncV1',jsonb_build_object('privateSnapshotTablePresent',
    pg_catalog.to_regclass('growthbrain_sync_v1_private.snapshots') IS NOT NULL,
    'rpcSignaturePresent',(SELECT jsonb_object_agg(name,present) FROM contract),
    'qualifiedForWrites',false),
  'limits',jsonb_build_object('tables',40,'columnsPerTable',32,'policiesPerTable',12,'publicFunctions',40,
    'argumentsPerFunction',12,'rolesPerPolicy',12),
  'columnTuple','[name, type, notNull]'
) AS report;
