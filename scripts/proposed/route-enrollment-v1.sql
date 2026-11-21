-- Staging proposal. Requires an inspected Supabase catalog. Creates new objects
-- only and aborts on collisions. Run within a single transaction.
begin;
create schema growthbrain_route_v1_private;
revoke all on schema growthbrain_route_v1_private from public,anon,authenticated;
create table growthbrain_route_v1_private.claims(
  account_id uuid not null, device_id uuid not null, request_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(account_id,request_id)
);
create index route_claims_time on growthbrain_route_v1_private.claims(created_at);
create index route_claims_account_time on growthbrain_route_v1_private.claims(account_id,created_at);
alter table growthbrain_route_v1_private.claims enable row level security;
revoke all on growthbrain_route_v1_private.claims from public,anon,authenticated;
grant usage on schema growthbrain_route_v1_private to service_role;
grant select, insert, delete on growthbrain_route_v1_private.claims to service_role;
create function public.gb_route_claim_v1(p_account uuid,p_device uuid,p_request uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare reserved int; known boolean; devices int; daily int;
begin
  if p_account is null or p_device is null or p_request is null then raise exception 'INVALID_REQUEST'; end if;
  -- Serialize quota checks and reservation across function instances.
  perform pg_catalog.pg_advisory_xact_lock(212236462,1);
  delete from growthbrain_route_v1_private.claims where created_at < now()-interval '30 days';
  if exists(select 1 from growthbrain_route_v1_private.claims where account_id=p_account and request_id=p_request)
    then return 'duplicate'; end if;
  select count(*) into daily from growthbrain_route_v1_private.claims where created_at>now()-interval '1 day';
  select count(*) filter(where created_at>now()-interval '1 day'),count(distinct device_id),bool_or(device_id=p_device)
    into reserved,devices,known from growthbrain_route_v1_private.claims where account_id=p_account;
  if daily>=500 or reserved>=24 or (not coalesce(known,false) and devices>=5) then return 'limit'; end if;
  insert into growthbrain_route_v1_private.claims(account_id,device_id,request_id) values(p_account,p_device,p_request);
  return 'claimed';
end $$;
revoke all on function public.gb_route_claim_v1(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.gb_route_claim_v1(uuid,uuid,uuid) to service_role;
commit;
