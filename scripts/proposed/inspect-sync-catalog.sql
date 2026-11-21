-- Metadata only, executed inside the inspector's read-only transaction.
-- Output is compared with the reviewed candidate installed on disposable PostgreSQL.
with roles as (
  select oid, rolname from pg_roles where rolname in ('anon','authenticated','growthbrain_sync_v1_executor')
), relations as (
  select c.*, n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='growthbrain_sync_v1_private' and c.relkind in ('r','p','v','m','f')
), funcs as (
  select p.*, n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='growthbrain_sync_v1_private' or (n.nspname='public' and left(p.proname,19)='growthbrain_sync_v1')
)
select jsonb_build_object(
 'readOnly', current_setting('transaction_read_only')='on',
 'catalog', jsonb_build_object(
  'roles', (select jsonb_agg(jsonb_build_array(r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolreplication,
     case when r.rolname='growthbrain_sync_v1_executor' then r.rolcanlogin else false end,
     pg_has_role(r.oid,'growthbrain_sync_v1_executor','MEMBER')) order by r.rolname)
    from pg_roles r where r.oid in (select oid from roles)),
  'executorMemberships', (select count(*) from pg_auth_members where member='growthbrain_sync_v1_executor'::regrole),
  'schemaRights', (select jsonb_agg(jsonb_build_array(r.rolname,has_schema_privilege(r.oid,n.oid,'USAGE'),has_schema_privilege(r.oid,n.oid,'CREATE')) order by r.rolname)
    from roles r cross join pg_namespace n where n.nspname='growthbrain_sync_v1_private'),
  'tables', (select jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
      c.relowner=(select oid from pg_roles where rolname='growthbrain_sync_v1_executor'),
      (select count(*) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
      (select count(*) from pg_rewrite rw where rw.ev_class=c.oid),
      (select jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) order by a.attnum)
       from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      (select jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k
       where k.conrelid=c.oid and k.contype in ('p','f','c','u','x')),
      (select jsonb_agg(jsonb_build_array(r.rolname,has_table_privilege(r.oid,c.oid,'SELECT'),has_table_privilege(r.oid,c.oid,'INSERT'),
        has_table_privilege(r.oid,c.oid,'UPDATE'),has_table_privilege(r.oid,c.oid,'DELETE'),has_table_privilege(r.oid,c.oid,'TRUNCATE'),
        has_any_column_privilege(r.oid,c.oid,'SELECT'),has_any_column_privilege(r.oid,c.oid,'INSERT'),has_any_column_privilege(r.oid,c.oid,'UPDATE')) order by r.rolname) from roles r)
    ) order by c.relname) from relations c),
  'policies',(select jsonb_agg(jsonb_build_array(p.tablename,p.policyname,p.permissive,p.roles,p.cmd,p.qual,p.with_check) order by p.tablename,p.policyname)
    from pg_policies p where p.schemaname='growthbrain_sync_v1_private'),
  'functions',(select jsonb_agg(jsonb_build_array(f.nspname,f.proname,pg_get_function_identity_arguments(f.oid),
      pg_get_function_result(f.oid),l.lanname,f.prosecdef,f.proleakproof,f.proisstrict,f.provolatile,f.proconfig,
      f.proowner='growthbrain_sync_v1_executor'::regrole,encode(sha256(convert_to(f.prosrc,'UTF8')),'hex'),
      (select jsonb_agg(jsonb_build_array(r.rolname,has_function_privilege(r.oid,f.oid,'EXECUTE')) order by r.rolname) from roles r)
    ) order by f.nspname,f.proname,pg_get_function_identity_arguments(f.oid))
    from funcs f join pg_language l on l.oid=f.prolang)
 )
) as report;
