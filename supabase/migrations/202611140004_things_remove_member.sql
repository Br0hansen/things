-- Let the owner of a home remove another member.
-- Ownership is checked here, server side, from the caller's active device.
-- The removed member's devices and pending transfer links stop working at once.

create or replace function public.things_remove_member(
  p_device_id uuid,
  p_member_id uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_device public.things_member_devices%rowtype;
  v_caller public.things_members%rowtype;
begin
  select * into v_device from public.things_member_devices
    where id = p_device_id and revoked_at is null;
  if not found then raise exception 'device_invalid'; end if;

  -- Serialise membership changes per home.
  perform 1 from public.things_homes where id = v_device.home_id for update;

  select * into v_caller from public.things_members
    where id = v_device.member_id and left_at is null;
  if not found then raise exception 'device_invalid'; end if;
  if v_caller.role <> 'owner' then raise exception 'not_owner'; end if;
  if p_member_id = v_caller.id then raise exception 'cannot_remove_self'; end if;

  update public.things_members set left_at = now()
    where id = p_member_id and home_id = v_device.home_id and left_at is null;
  if not found then raise exception 'member_not_found'; end if;

  update public.things_member_devices set revoked_at = now()
    where member_id = p_member_id and revoked_at is null;
  update public.things_invites set used_at = now()
    where member_id = p_member_id and kind = 'transfer' and used_at is null;
end;
$$;

revoke all on function public.things_remove_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.things_remove_member(uuid, uuid) to service_role;
