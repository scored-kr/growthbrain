-- Run this single catalog query in the Growth brain project's SQL Editor (PostgreSQL 15+).
-- The name filter covers every overload of the selected public functions. It does
-- not find differently named routines, follow private callees or verify behavior.
-- EXECUTE is an effective database privilege; a missing API role yields JSON null.
-- Owner rights include inherited role privileges. Forced RLS and BYPASSRLS are separate.
-- Search path classifications describe only the explicit function setting.
-- The hash identifies exact UTF-8 prosrc bytes for text-bodied SQL/PLpgSQL only.
-- Constraint columns and unique index keys identify candidates, not their predicates.
-- Bodies, predicates, default expressions, other settings and application rows stay out.
WITH tables AS (
  SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND c.relname IN ('encrypted_vaults', 'encrypted_vault_chunks')
), routines AS (
  SELECT p.*, l.lanname, owner.rolsuper, owner.rolbypassrls,
    (SELECT pg_catalog.btrim(pg_catalog.substr(cfg, 13))
     FROM pg_catalog.unnest(p.proconfig) cfg
     WHERE pg_catalog.starts_with(cfg, 'search_path=')) AS path_setting
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND (pg_catalog.strpos(pg_catalog.lower(p.proname), 'vault') > 0
      OR p.proname = 'cipher_envelope_bytes'
      OR pg_catalog.starts_with(p.proname, 'growthbrain_sync_v1_'))
), arguments AS (
  SELECT f.oid, a.pos, COALESCE(f.proargmodes[a.pos], 'i') AS mode,
    pg_catalog.jsonb_build_object(
      'name', NULLIF(f.proargnames[a.pos], ''),
      'type', pg_catalog.format_type(a.type_id, NULL),
      'mode', CASE COALESCE(f.proargmodes[a.pos], 'i')
        WHEN 'i' THEN 'in' WHEN 'o' THEN 'out' WHEN 'b' THEN 'inout'
        WHEN 'v' THEN 'variadic' WHEN 't' THEN 'table' END) AS detail
  FROM routines f CROSS JOIN LATERAL
    pg_catalog.unnest(COALESCE(f.proallargtypes, f.proargtypes::pg_catalog.oid[]))
      WITH ORDINALITY a(type_id, pos)
), function_details AS (
  SELECT f.proname, f.oid, pg_catalog.jsonb_build_object(
    'name', f.proname,
    'inputArgs', COALESCE((SELECT pg_catalog.jsonb_agg(a.detail ORDER BY a.pos)
      FROM arguments a WHERE a.oid = f.oid AND a.mode IN ('i', 'b', 'v')), '[]'),
    'outputArgs', COALESCE((SELECT pg_catalog.jsonb_agg(a.detail ORDER BY a.pos)
      FROM arguments a WHERE a.oid = f.oid AND a.mode IN ('o', 'b', 't')), '[]'),
    'defaultCount', f.pronargdefaults, 'returns', pg_catalog.pg_get_function_result(f.oid),
    'returnsSet', f.proretset, 'language', f.lanname, 'securityDefiner', f.prosecdef,
    'execute', pg_catalog.jsonb_build_object(
      'anon', (SELECT pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE') FROM pg_catalog.pg_roles r WHERE r.rolname = 'anon'),
      'authenticated', (SELECT pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE') FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticated')),
    'owner', pg_catalog.jsonb_build_object('superuser', f.rolsuper, 'bypassRls', f.rolbypassrls,
      'ownsTables', COALESCE((SELECT pg_catalog.jsonb_agg(t.relname ORDER BY t.relname)
        FROM tables t WHERE t.relowner = f.proowner), '[]'),
      'hasOwnerRightsOn', COALESCE((SELECT pg_catalog.jsonb_agg(t.relname ORDER BY t.relname)
        FROM tables t WHERE pg_catalog.pg_has_role(f.proowner, t.relowner, 'USAGE')), '[]')),
    'searchPath', CASE WHEN f.path_setting IS NULL THEN 'inherited'
      WHEN f.path_setting IN ('', '""') THEN 'empty'
      WHEN f.path_setting IN ('pg_catalog', '"pg_catalog"') THEN 'pg_catalog_only' ELSE 'other' END,
    'sourceSha256', CASE WHEN f.lanname IN ('sql', 'plpgsql') AND f.prosqlbody IS NULL THEN
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.prosrc, 'UTF8')), 'hex') END
  ) AS detail FROM routines f
), table_details AS (
  SELECT t.relname, pg_catalog.jsonb_build_object(
    'name', t.relname, 'rls', t.relrowsecurity, 'forceRls', t.relforcerowsecurity,
    'columns', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, NULL), 'notNull', a.attnotnull) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'),
    'constraints', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', k.conname, 'kind', k.contype, 'validated', k.convalidated,
      'columns', ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY key(num, pos)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.num ORDER BY key.pos),
      'foreignTable', CASE WHEN k.contype = 'f' THEN pg_catalog.jsonb_build_object('schema', fn.nspname, 'name', ft.relname) END,
      'foreignColumns', ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY key(num, pos)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = key.num ORDER BY key.pos)
    ) ORDER BY k.conname) FROM pg_catalog.pg_constraint k
      LEFT JOIN pg_catalog.pg_class ft ON ft.oid = k.confrelid
      LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = ft.relnamespace WHERE k.conrelid = t.oid), '[]'),
    'uniqueIndexes', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', c.relname, 'valid', i.indisvalid, 'ready', i.indisready, 'partial', i.indpred IS NOT NULL,
      'hasExpressions', i.indexprs IS NOT NULL, 'nullsNotDistinct', i.indnullsnotdistinct,
      'columns', ARRAY(SELECT a.attname FROM pg_catalog.unnest(i.indkey) WITH ORDINALITY key(num, pos)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.num
        WHERE key.pos <= i.indnkeyatts ORDER BY key.pos)
    ) ORDER BY c.relname) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = t.oid AND i.indisunique), '[]')
  ) AS detail FROM tables t
)
SELECT pg_catalog.jsonb_build_object(
  'report', 'growthbrain-vault-rpc-inventory-v1', 'schema', 'public',
  'functions', COALESCE((SELECT pg_catalog.jsonb_agg(detail ORDER BY proname, oid) FROM function_details), '[]'),
  'tables', COALESCE((SELECT pg_catalog.jsonb_agg(detail ORDER BY relname) FROM table_details), '[]')
) AS report;
