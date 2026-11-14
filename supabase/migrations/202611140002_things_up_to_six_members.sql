-- Allow up to six active members per home (was two).
-- The home row is locked so two simultaneous joins cannot exceed the limit.

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
  perform 1 from things_homes where id = v_invite.home_id for update;
  select count(*) into v_count from things_members where home_id = v_invite.home_id and left_at is null;
  if v_count >= 6 then raise exception 'home_full'; end if;
  if v_name = '' then raise exception 'invalid_name'; end if;
  insert into things_members(id, home_id, display_name) values (v_member_id, v_invite.home_id, v_name);
  insert into things_member_devices(id, home_id, member_id, token_hash) values (v_device_id, v_invite.home_id, v_member_id, p_device_token_hash);
  update things_invites set used_at = now() where id = v_invite.id;
  return jsonb_build_object(
    'homeId', v_invite.home_id, 'memberId', v_member_id, 'deviceId', v_device_id, 'displayName', v_name
  );
end;
$$;
