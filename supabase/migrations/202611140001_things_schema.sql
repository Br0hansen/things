-- Things is isolated from the rest of DailyPep by the `things_` prefix.
-- Browser clients never access these tables directly; all access goes through
-- the things-api Edge Function with a service-role client after device auth.

create extension if not exists pgcrypto;
create sequence if not exists public.things_sync_sequence;

create table if not exists public.things_homes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.things_members (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.things_homes(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at timestamptz not null default now(),
  left_at timestamptz
);

create unique index if not exists things_members_two_active_slots
  on public.things_members(home_id, id)
  where left_at is null;

create table if not exists public.things_member_devices (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.things_homes(id) on delete cascade,
  member_id uuid not null references public.things_members(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists things_member_devices_home_idx on public.things_member_devices(home_id);

create table if not exists public.things_invites (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.things_homes(id) on delete cascade,
  member_id uuid references public.things_members(id) on delete cascade,
  kind text not null check (kind in ('partner', 'transfer')),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists things_invites_lookup_idx on public.things_invites(token_hash, expires_at) where used_at is null;

create table if not exists public.things_items (
  id uuid primary key,
  home_id uuid not null references public.things_homes(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  normalized_name text not null,
  status text not null check (status in ('have', 'soon', 'empty')),
  changed_at timestamptz not null,
  changed_by uuid not null references public.things_members(id),
  mutation_id uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  sync_seq bigint not null default nextval('public.things_sync_sequence')
);

create unique index if not exists things_items_active_name_idx
  on public.things_items(home_id, normalized_name)
  where deleted_at is null;
create index if not exists things_items_sync_idx on public.things_items(home_id, sync_seq);

create table if not exists public.things_mutations (
  id uuid primary key,
  home_id uuid not null references public.things_homes(id) on delete cascade,
  device_id uuid not null references public.things_member_devices(id) on delete cascade,
  item_id uuid not null,
  operation text not null check (operation in ('upsert', 'delete')),
  changed_at timestamptz not null,
  accepted boolean not null default false,
  reason text,
  received_at timestamptz not null default now()
);

create table if not exists public.things_events (
  id bigint generated always as identity primary key,
  event_name text not null check (event_name in (
    'home_created', 'partner_joined', 'item_created', 'status_changed',
    'item_deleted', 'shopping_checked', 'undo', 'installed', 'sync_error'
  )),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create or replace function public.things_bump_item_sync_seq()
returns trigger language plpgsql set search_path = public as $$
begin
  new.sync_seq := nextval('public.things_sync_sequence');
  return new;
end;
$$;

drop trigger if exists things_items_sync_seq_trigger on public.things_items;
create trigger things_items_sync_seq_trigger
before update on public.things_items
for each row execute function public.things_bump_item_sync_seq();

create or replace function public.things_create_home(p_display_name text, p_token_hash text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_home_id uuid := gen_random_uuid();
  v_member_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_name text := left(regexp_replace(trim(p_display_name), '\s+', ' ', 'g'), 60);
begin
  if v_name = '' or p_token_hash is null or char_length(p_token_hash) < 32 then
    raise exception 'invalid_input';
  end if;
  insert into things_homes(id) values (v_home_id);
  insert into things_members(id, home_id, display_name) values (v_member_id, v_home_id, v_name);
  insert into things_member_devices(id, home_id, member_id, token_hash) values (v_device_id, v_home_id, v_member_id, p_token_hash);
  return jsonb_build_object(
    'homeId', v_home_id, 'memberId', v_member_id, 'deviceId', v_device_id, 'displayName', v_name
  );
end;
$$;

create or replace function public.things_join_invite(p_token_hash text, p_display_name text, p_device_token_hash text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_invite things_invites%rowtype;
  v_member_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_name text := left(regexp_replace(trim(p_display_name), '\s+', ' ', 'g'), 60);
  v_count int;
begin
  select * into v_invite from things_invites
    where token_hash = p_token_hash and kind = 'partner' and used_at is null and expires_at > now()
    for update;
  if not found then raise exception 'invite_invalid'; end if;
  select count(*) into v_count from things_members where home_id = v_invite.home_id and left_at is null;
  if v_count >= 2 then raise exception 'home_full'; end if;
  if v_name = '' then raise exception 'invalid_name'; end if;
  insert into things_members(id, home_id, display_name) values (v_member_id, v_invite.home_id, v_name);
  insert into things_member_devices(id, home_id, member_id, token_hash) values (v_device_id, v_invite.home_id, v_member_id, p_device_token_hash);
  update things_invites set used_at = now() where id = v_invite.id;
  return jsonb_build_object(
    'homeId', v_invite.home_id, 'memberId', v_member_id, 'deviceId', v_device_id, 'displayName', v_name
  );
end;
$$;

create or replace function public.things_consume_transfer(p_token_hash text, p_device_token_hash text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_invite things_invites%rowtype;
  v_member things_members%rowtype;
  v_device_id uuid := gen_random_uuid();
begin
  select * into v_invite from things_invites
    where token_hash = p_token_hash and kind = 'transfer' and used_at is null and expires_at > now()
    for update;
  if not found then raise exception 'transfer_invalid'; end if;
  select * into v_member from things_members where id = v_invite.member_id and left_at is null;
  if not found then raise exception 'member_inactive'; end if;
  insert into things_member_devices(id, home_id, member_id, token_hash)
    values (v_device_id, v_invite.home_id, v_member.id, p_device_token_hash);
  update things_invites set used_at = now() where id = v_invite.id;
  return jsonb_build_object(
    'homeId', v_invite.home_id, 'memberId', v_member.id, 'deviceId', v_device_id, 'displayName', v_member.display_name
  );
end;
$$;

create or replace function public.things_apply_item_mutation(p_device_id uuid, p_mutation jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_device things_member_devices%rowtype;
  v_existing things_items%rowtype;
  v_duplicate things_items%rowtype;
  v_item jsonb := p_mutation->'item';
  v_mutation_id uuid := (p_mutation->>'id')::uuid;
  v_item_id uuid := (p_mutation->>'itemId')::uuid;
  v_operation text := p_mutation->>'operation';
  v_changed_at timestamptz := least((p_mutation->>'changedAt')::timestamptz, now() + interval '5 minutes');
  v_name text := left(regexp_replace(trim(v_item->>'name'), '\s+', ' ', 'g'), 60);
  v_normalized text := lower(left(regexp_replace(trim(v_item->>'normalizedName'), '\s+', ' ', 'g'), 60));
  v_status text := v_item->>'status';
begin
  select * into v_device from things_member_devices
    where id = p_device_id and revoked_at is null for update;
  if not found then raise exception 'device_invalid'; end if;
  if v_operation not in ('upsert', 'delete') or v_status not in ('have', 'soon', 'empty') or v_name = '' then
    raise exception 'mutation_invalid';
  end if;

  if exists(select 1 from things_mutations where id = v_mutation_id) then
    select * into v_existing from things_items where id = v_item_id;
    return coalesce(to_jsonb(v_existing), '{}'::jsonb);
  end if;

  select * into v_existing from things_items where id = v_item_id and home_id = v_device.home_id for update;
  if found and (v_existing.changed_at > v_changed_at or
    (v_existing.changed_at = v_changed_at and v_existing.mutation_id::text >= v_mutation_id::text)) then
    insert into things_mutations(id, home_id, device_id, item_id, operation, changed_at, accepted, reason)
      values (v_mutation_id, v_device.home_id, p_device_id, v_item_id, v_operation, v_changed_at, false, 'stale');
    update things_member_devices set last_seen_at = now() where id = p_device_id;
    return to_jsonb(v_existing);
  end if;

  if v_operation = 'upsert' then
    select * into v_duplicate from things_items
      where home_id = v_device.home_id and normalized_name = v_normalized and deleted_at is null and id <> v_item_id
      order by created_at asc limit 1 for update;
    if found then
      if v_duplicate.changed_at < v_changed_at or
        (v_duplicate.changed_at = v_changed_at and v_duplicate.mutation_id::text < v_mutation_id::text) then
        update things_items set name = v_name, status = v_status, changed_at = v_changed_at,
          changed_by = v_device.member_id, mutation_id = v_mutation_id
          where id = v_duplicate.id returning * into v_duplicate;
      end if;
      if v_existing.id is not null then
        update things_items set deleted_at = v_changed_at, changed_at = v_changed_at,
          changed_by = v_device.member_id, mutation_id = v_mutation_id where id = v_existing.id;
      end if;
      insert into things_mutations(id, home_id, device_id, item_id, operation, changed_at, accepted, reason)
        values (v_mutation_id, v_device.home_id, p_device_id, v_duplicate.id, v_operation, v_changed_at, true, 'merged_duplicate');
      update things_member_devices set last_seen_at = now() where id = p_device_id;
      return to_jsonb(v_duplicate);
    end if;
  end if;

  insert into things_items(id, home_id, name, normalized_name, status, changed_at, changed_by, mutation_id, deleted_at)
    values (v_item_id, v_device.home_id, v_name, v_normalized, v_status, v_changed_at, v_device.member_id, v_mutation_id,
      case when v_operation = 'delete' then v_changed_at else null end)
  on conflict (id) do update set
    name = excluded.name, normalized_name = excluded.normalized_name, status = excluded.status,
    changed_at = excluded.changed_at, changed_by = excluded.changed_by, mutation_id = excluded.mutation_id,
    deleted_at = excluded.deleted_at
  returning * into v_existing;

  insert into things_mutations(id, home_id, device_id, item_id, operation, changed_at, accepted)
    values (v_mutation_id, v_device.home_id, p_device_id, v_item_id, v_operation, v_changed_at, true);
  update things_member_devices set last_seen_at = now() where id = p_device_id;
  return to_jsonb(v_existing);
end;
$$;

create or replace function public.things_leave_home(p_device_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_device things_member_devices%rowtype;
begin
  select * into v_device from things_member_devices where id = p_device_id and revoked_at is null for update;
  if not found then raise exception 'device_invalid'; end if;
  update things_members set left_at = now() where id = v_device.member_id;
  update things_member_devices set revoked_at = now() where member_id = v_device.member_id;
  if not exists(select 1 from things_members where home_id = v_device.home_id and left_at is null) then
    delete from things_homes where id = v_device.home_id;
  end if;
end;
$$;

alter table public.things_homes enable row level security;
alter table public.things_members enable row level security;
alter table public.things_member_devices enable row level security;
alter table public.things_invites enable row level security;
alter table public.things_items enable row level security;
alter table public.things_mutations enable row level security;
alter table public.things_events enable row level security;

revoke all on public.things_homes, public.things_members, public.things_member_devices,
  public.things_invites, public.things_items, public.things_mutations, public.things_events
  from anon, authenticated;
revoke all on function public.things_create_home(text, text) from public, anon, authenticated;
revoke all on function public.things_join_invite(text, text, text) from public, anon, authenticated;
revoke all on function public.things_consume_transfer(text, text) from public, anon, authenticated;
revoke all on function public.things_apply_item_mutation(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.things_leave_home(uuid) from public, anon, authenticated;
grant execute on function public.things_create_home(text, text) to service_role;
grant execute on function public.things_join_invite(text, text, text) to service_role;
grant execute on function public.things_consume_transfer(text, text) to service_role;
grant execute on function public.things_apply_item_mutation(uuid, jsonb) to service_role;
grant execute on function public.things_leave_home(uuid) to service_role;

