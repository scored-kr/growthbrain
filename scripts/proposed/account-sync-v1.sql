-- Candidate contract for a disposable database. Do not run against a linked project.
-- Review existing catalog, role names and all applicable data before any migration.
begin;
create schema growthbrain_sync_v1_private;
revoke all on schema growthbrain_sync_v1_private from public, anon, authenticated;

-- Functions execute with a fresh, non-login role subject to row policies. App
-- users may execute the RPC but cannot edit the storage or change their quota.
create role growthbrain_sync_v1_executor nologin nobypassrls;
grant usage on schema auth to growthbrain_sync_v1_executor;
grant execute on function auth.uid() to growthbrain_sync_v1_executor;
grant usage on schema growthbrain_sync_v1_private to authenticated, growthbrain_sync_v1_executor;

create table growthbrain_sync_v1_private.snapshots (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision uuid not null,
  payload jsonb
);
create table growthbrain_sync_v1_private.storage_limits (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  quota_bytes integer not null check (quota_bytes between 0 and 52428800)
);
alter table growthbrain_sync_v1_private.snapshots enable row level security;
alter table growthbrain_sync_v1_private.snapshots force row level security;
alter table growthbrain_sync_v1_private.storage_limits enable row level security;
alter table growthbrain_sync_v1_private.storage_limits force row level security;
create policy manage_own on growthbrain_sync_v1_private.snapshots
  for all to growthbrain_sync_v1_executor
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy read_own_limit on growthbrain_sync_v1_private.storage_limits
  for select to growthbrain_sync_v1_executor using (owner_id = (select auth.uid()));
revoke all on all tables in schema growthbrain_sync_v1_private from public, anon, authenticated;
grant select, insert, update, delete on growthbrain_sync_v1_private.snapshots to growthbrain_sync_v1_executor;
grant select on growthbrain_sync_v1_private.storage_limits to growthbrain_sync_v1_executor;

-- No user-provided fields outside the closed cryptographic envelope are stored.
create function growthbrain_sync_v1_private.valid_box(box jsonb, wrapped boolean)
returns boolean language plpgsql immutable strict security invoker set search_path = '' as $$
declare
  ciphertext text := box->>'ciphertext';
  decoded bytea;
begin
  if jsonb_typeof(box) <> 'object' or not (box ?& array['iv','tag','ciphertext'])
     or box - array['iv','tag','ciphertext'] <> '{}'::jsonb
     or jsonb_typeof(box->'iv') <> 'string' or jsonb_typeof(box->'tag') <> 'string'
     or jsonb_typeof(box->'ciphertext') <> 'string'
     or octet_length(box->>'iv') <> 16 or octet_length(box->>'tag') <> 24
     or octet_length(ciphertext) not between 4 and 16777216
     or (wrapped and octet_length(ciphertext) <> 44) then return false; end if;
  decoded := decode(ciphertext, 'base64');
  return octet_length(decode(box->>'iv','base64')) = 12
    and octet_length(decode(box->>'tag','base64')) = 16
    and encode(decode(box->>'iv','base64'),'base64') = box->>'iv'
    and encode(decode(box->>'tag','base64'),'base64') = box->>'tag'
    and octet_length(decoded) between 1 and 12582912
    and (not wrapped or octet_length(decoded) = 32)
    and replace(encode(decoded,'base64'), chr(10), '') = ciphertext;
exception when data_exception then return false;
end $$;
revoke all on function growthbrain_sync_v1_private.valid_box(jsonb, boolean) from public, anon, authenticated;
grant execute on function growthbrain_sync_v1_private.valid_box(jsonb, boolean) to growthbrain_sync_v1_executor;

create function growthbrain_sync_v1_private.operate(operation text, expected_revision uuid, new_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  subject uuid := auth.uid();
  current_revision uuid;
  current_payload jsonb;
  allowance integer;
  used integer;
  response jsonb;
begin
  if subject is null then raise sqlstate '42501' using message = 'SYNC_AUTH_REQUIRED'; end if;
  if operation not in ('status','read','write','purge') or operation is null then
    raise sqlstate 'PT400' using message = 'SYNC_INVALID_REQUEST';
  end if;
  if operation in ('write','purge') then
    -- Also serialize first creation and purge of an account without a row.
    perform pg_advisory_xact_lock(hashtextextended(subject::text, 93731));
  end if;
  select s.revision, s.payload into current_revision, current_payload
    from growthbrain_sync_v1_private.snapshots s where s.owner_id = subject;
  select coalesce((select quota_bytes from growthbrain_sync_v1_private.storage_limits where owner_id = subject), 52428800)
    into allowance;
  if operation in ('write','purge') then
    if expected_revision is distinct from current_revision then
      raise sqlstate 'PT409' using message = 'SYNC_CONFLICT';
    end if;
    if operation = 'write' then
      if new_payload is null or jsonb_typeof(new_payload) <> 'object' then
        raise sqlstate 'PT400' using message = 'SYNC_INVALID_ENVELOPE';
      end if;
      if octet_length(new_payload::text) > allowance then raise sqlstate 'PT413' using message = 'SYNC_QUOTA'; end if;
      if not (new_payload ?& array['version','vaultId','sequence','parentRevision','wrapped','body'])
         or new_payload - array['version','vaultId','sequence','parentRevision','wrapped','body'] <> '{}'::jsonb
         or new_payload->'version' <> '1'::jsonb
         or jsonb_typeof(new_payload->'vaultId') <> 'string'
         or new_payload->>'vaultId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or jsonb_typeof(new_payload->'sequence') <> 'number'
         or (new_payload->>'sequence') !~ '^[1-9][0-9]{0,9}$'
         or (new_payload->>'sequence')::numeric > 2147483647
         or new_payload->'parentRevision' is distinct from coalesce(to_jsonb(expected_revision), 'null'::jsonb)
         or growthbrain_sync_v1_private.valid_box(new_payload->'wrapped', true) is not true
         or growthbrain_sync_v1_private.valid_box(new_payload->'body', false) is not true then
        raise sqlstate 'PT400' using message = 'SYNC_INVALID_ENVELOPE';
      end if;
      if (new_payload->>'sequence')::bigint <> coalesce((current_payload->>'sequence')::bigint,0)+1
         or (current_payload is not null and new_payload->>'vaultId' <> current_payload->>'vaultId') then
        raise sqlstate 'PT409' using message = 'SYNC_CONFLICT';
      end if;
      current_payload := new_payload;
    else
      -- Physically delete this contract's ciphertext. Keep only a fresh epoch
      -- so an offline client cannot recreate the old account snapshot by CAS.
      delete from growthbrain_sync_v1_private.snapshots where owner_id = subject;
      current_payload := null;
    end if;
    current_revision := gen_random_uuid();
    insert into growthbrain_sync_v1_private.snapshots(owner_id, revision, payload)
      values(subject, current_revision, current_payload)
      on conflict (owner_id) do update set revision = excluded.revision, payload = excluded.payload;
  end if;
  used := coalesce(octet_length(current_payload::text), 0);
  response := jsonb_build_object('contract','growthbrain.sync.v1','revision',current_revision,'bytes',used,'quota',allowance);
  if operation = 'read' then response := response || jsonb_build_object('payload',current_payload); end if;
  return response;
end $$;
grant create on schema growthbrain_sync_v1_private to growthbrain_sync_v1_executor;
alter function growthbrain_sync_v1_private.operate(text,uuid,jsonb) owner to growthbrain_sync_v1_executor;
revoke create on schema growthbrain_sync_v1_private from growthbrain_sync_v1_executor;
revoke all on function growthbrain_sync_v1_private.operate(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function growthbrain_sync_v1_private.operate(text,uuid,jsonb) to authenticated;

create function public.growthbrain_sync_v1_status() returns jsonb
  language sql security invoker set search_path = '' as $$select growthbrain_sync_v1_private.operate('status',null,null)$$;
create function public.growthbrain_sync_v1_read() returns jsonb
  language sql security invoker set search_path = '' as $$select growthbrain_sync_v1_private.operate('read',null,null)$$;
create function public.growthbrain_sync_v1_write(expected_revision uuid,payload jsonb) returns jsonb
  language sql security invoker set search_path = '' as $$select growthbrain_sync_v1_private.operate('write',expected_revision,payload)$$;
create function public.growthbrain_sync_v1_purge(expected_revision uuid) returns jsonb
  language sql security invoker set search_path = '' as $$select growthbrain_sync_v1_private.operate('purge',expected_revision,null)$$;

revoke all on function public.growthbrain_sync_v1_status(), public.growthbrain_sync_v1_read(),
  public.growthbrain_sync_v1_write(uuid,jsonb), public.growthbrain_sync_v1_purge(uuid) from public, anon, authenticated;
grant execute on function public.growthbrain_sync_v1_status(), public.growthbrain_sync_v1_read(),
  public.growthbrain_sync_v1_write(uuid,jsonb), public.growthbrain_sync_v1_purge(uuid) to authenticated;
commit;
