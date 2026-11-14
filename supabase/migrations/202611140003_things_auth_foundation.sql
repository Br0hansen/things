-- Hybrid Supabase Auth foundation for Things.
-- Existing device-token access remains valid during the migration period.

create table if not exists public.things_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  linked_at timestamptz not null default now()
);

alter table public.things_members
  add column if not exists user_id uuid references public.things_users(id) on delete restrict,
  add column if not exists role text not null default 'member';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'things_members_role_check'
  ) then
    alter table public.things_members
      add constraint things_members_role_check check (role in ('owner', 'member'));
  end if;
end;
$$;

-- The oldest active member owns each existing home. This is deterministic and
-- leaves all current memberships and device tokens untouched.
with first_members as (
  select distinct on (home_id) id
  from public.things_members
  where left_at is null
  order by home_id, created_at, id
)
update public.things_members
set role = 'owner'
where id in (select id from first_members);

create unique index if not exists things_members_active_user_home_idx
  on public.things_members(home_id, user_id)
  where user_id is not null and left_at is null;

alter table public.things_users enable row level security;
revoke all on public.things_users from public, anon, authenticated;

create or replace function public.things_create_authenticated_home(
  p_display_name text,
  p_token_hash text,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid;
  v_home_id uuid := gen_random_uuid();
  v_member_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_name text := left(regexp_replace(trim(p_display_name), '\s+', ' ', 'g'), 60);
begin
  if p_auth_user_id is null or not exists(select 1 from auth.users where id = p_auth_user_id) then
    raise exception 'auth_user_invalid';
  end if;
  if v_name = '' or p_token_hash is null or char_length(p_token_hash) < 32 then
    raise exception 'invalid_input';
  end if;

  insert into public.things_users(auth_user_id)
    values (p_auth_user_id)
    on conflict (auth_user_id) do update set linked_at = now()
    returning id into v_user_id;

  insert into public.things_homes(id) values (v_home_id);
  insert into public.things_members(id, home_id, user_id, role, display_name)
    values (v_member_id, v_home_id, v_user_id, 'owner', v_name);
  insert into public.things_member_devices(id, home_id, member_id, token_hash)
    values (v_device_id, v_home_id, v_member_id, p_token_hash);

  return jsonb_build_object(
    'homeId', v_home_id,
    'memberId', v_member_id,
    'deviceId', v_device_id,
    'displayName', v_name,
    'userId', v_user_id,
    'role', 'owner'
  );
end;
$$;

create or replace function public.things_join_authenticated_invite(
  p_token_hash text,
  p_display_name text,
  p_device_token_hash text,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_invite public.things_invites%rowtype;
  v_user_id uuid;
  v_member_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_name text := left(regexp_replace(trim(p_display_name), '\s+', ' ', 'g'), 60);
  v_count int;
begin
  if p_auth_user_id is null or not exists(select 1 from auth.users where id = p_auth_user_id) then
    raise exception 'auth_user_invalid';
  end if;

  select * into v_invite from public.things_invites
    where token_hash = p_token_hash and kind = 'partner'
      and used_at is null and expires_at > now()
    for update;
  if not found then raise exception 'invite_invalid'; end if;

  perform 1 from public.things_homes where id = v_invite.home_id for update;
  select count(*) into v_count from public.things_members
    where home_id = v_invite.home_id and left_at is null;
  if v_count >= 6 then raise exception 'home_full'; end if;
  if v_name = '' then raise exception 'invalid_name'; end if;

  insert into public.things_users(auth_user_id)
    values (p_auth_user_id)
    on conflict (auth_user_id) do update set linked_at = now()
    returning id into v_user_id;

  if exists(
    select 1 from public.things_members
    where home_id = v_invite.home_id and user_id = v_user_id and left_at is null
  ) then
    raise exception 'already_member';
  end if;

  insert into public.things_members(id, home_id, user_id, role, display_name)
    values (v_member_id, v_invite.home_id, v_user_id, 'member', v_name);
  insert into public.things_member_devices(id, home_id, member_id, token_hash)
    values (v_device_id, v_invite.home_id, v_member_id, p_device_token_hash);
  update public.things_invites set used_at = now() where id = v_invite.id;

  return jsonb_build_object(
    'homeId', v_invite.home_id,
    'memberId', v_member_id,
    'deviceId', v_device_id,
    'displayName', v_name,
    'userId', v_user_id,
    'role', 'member'
  );
end;
$$;

create or replace function public.things_claim_member(
  p_device_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_device public.things_member_devices%rowtype;
  v_member public.things_members%rowtype;
  v_user_id uuid;
begin
  if p_auth_user_id is null or not exists(select 1 from auth.users where id = p_auth_user_id) then
    raise exception 'auth_user_invalid';
  end if;

  select * into v_device from public.things_member_devices
    where id = p_device_id and revoked_at is null
    for update;
  if not found then raise exception 'device_invalid'; end if;

  select * into v_member from public.things_members
    where id = v_device.member_id and left_at is null
    for update;
  if not found then raise exception 'member_inactive'; end if;

  insert into public.things_users(auth_user_id)
    values (p_auth_user_id)
    on conflict (auth_user_id) do update set linked_at = now()
    returning id into v_user_id;

  if v_member.user_id is not null and v_member.user_id <> v_user_id then
    raise exception 'member_already_claimed';
  end if;
  if exists(
    select 1 from public.things_members
    where home_id = v_member.home_id and user_id = v_user_id
      and id <> v_member.id and left_at is null
  ) then
    raise exception 'already_member';
  end if;

  update public.things_members set user_id = v_user_id where id = v_member.id;

  return jsonb_build_object(
    'homeId', v_member.home_id,
    'memberId', v_member.id,
    'deviceId', v_device.id,
    'displayName', v_member.display_name,
    'userId', v_user_id,
    'role', v_member.role
  );
end;
$$;

revoke all on function public.things_create_authenticated_home(text, text, uuid) from public, anon, authenticated;
revoke all on function public.things_join_authenticated_invite(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.things_claim_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.things_create_authenticated_home(text, text, uuid) to service_role;
grant execute on function public.things_join_authenticated_invite(text, text, text, uuid) to service_role;
grant execute on function public.things_claim_member(uuid, uuid) to service_role;
