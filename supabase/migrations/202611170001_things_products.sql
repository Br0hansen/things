-- EAN barcodes on items, a shared product database and a global Kassal rate limit.
-- things_products is shared across all homes and stores no home, member or device ids.
-- As before, browser clients never access these tables directly.

alter table public.things_items add column if not exists eans text[] not null default '{}';

create table if not exists public.things_products (
  ean text primary key check (ean ~ '^[0-9]{8,14}$'),
  name text not null check (char_length(name) between 1 and 200),
  brand text,
  source text not null check (source in ('kassal', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.things_kassal_calls (
  id bigserial primary key,
  called_at timestamptz not null default now()
);

alter table public.things_events drop constraint if exists things_events_event_name_check;
alter table public.things_events add constraint things_events_event_name_check check (event_name in (
  'home_created', 'partner_joined', 'item_created', 'status_changed',
  'item_deleted', 'shopping_checked', 'undo', 'installed', 'sync_error', 'ean_lookup'
));

-- At most 5 Kassal calls per rolling minute across all users and function instances.
create or replace function public.things_take_kassal_slot()
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(7243150001);
  delete from things_kassal_calls where called_at < now() - interval '1 minute';
  select count(*) into v_count from things_kassal_calls;
  if v_count >= 5 then return false; end if;
  insert into things_kassal_calls default values;
  return true;
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
  -- Older clients do not send eans; their upserts keep the stored barcodes.
  v_has_eans boolean := coalesce(v_item ? 'eans', false);
  v_eans text[] := array(
    select e.value #>> '{}'
    from jsonb_array_elements(case when jsonb_typeof(v_item->'eans') = 'array' then v_item->'eans' else '[]'::jsonb end)
      with ordinality as e(value, ord)
    where jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ '^[0-9]{8,14}$'
    group by e.value #>> '{}'
    order by min(e.ord)
    limit 20
  );
  v_merged_eans text[];
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
      -- The surviving row keeps every barcode, even when this mutation is older and otherwise loses.
      v_merged_eans := array(
        select u.ean
        from unnest(v_duplicate.eans || v_eans || coalesce(v_existing.eans, '{}')) with ordinality as u(ean, ord)
        group by u.ean
        order by min(u.ord)
        limit 20
      );
      if v_duplicate.changed_at < v_changed_at or
        (v_duplicate.changed_at = v_changed_at and v_duplicate.mutation_id::text < v_mutation_id::text) then
        update things_items set name = v_name, status = v_status, changed_at = v_changed_at,
          changed_by = v_device.member_id, mutation_id = v_mutation_id, eans = v_merged_eans
          where id = v_duplicate.id returning * into v_duplicate;
      elsif v_merged_eans is distinct from v_duplicate.eans then
        update things_items set eans = v_merged_eans
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

  insert into things_items(id, home_id, name, normalized_name, status, changed_at, changed_by, mutation_id, deleted_at, eans)
    values (v_item_id, v_device.home_id, v_name, v_normalized, v_status, v_changed_at, v_device.member_id, v_mutation_id,
      case when v_operation = 'delete' then v_changed_at else null end, v_eans)
  on conflict (id) do update set
    name = excluded.name, normalized_name = excluded.normalized_name, status = excluded.status,
    changed_at = excluded.changed_at, changed_by = excluded.changed_by, mutation_id = excluded.mutation_id,
    deleted_at = excluded.deleted_at,
    eans = case when v_has_eans then excluded.eans else things_items.eans end
  returning * into v_existing;

  insert into things_mutations(id, home_id, device_id, item_id, operation, changed_at, accepted)
    values (v_mutation_id, v_device.home_id, p_device_id, v_item_id, v_operation, v_changed_at, true);
  update things_member_devices set last_seen_at = now() where id = p_device_id;
  return to_jsonb(v_existing);
end;
$$;

alter table public.things_products enable row level security;
alter table public.things_kassal_calls enable row level security;

revoke all on public.things_products, public.things_kassal_calls from anon, authenticated;
revoke all on sequence public.things_kassal_calls_id_seq from anon, authenticated;
revoke all on function public.things_take_kassal_slot() from public, anon, authenticated;
revoke all on function public.things_apply_item_mutation(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.things_take_kassal_slot() to service_role;
grant execute on function public.things_apply_item_mutation(uuid, jsonb) to service_role;
