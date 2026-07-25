-- Server-owned playback snapshots for late joiners and explicit re-sync.
--
-- Migration 004 intentionally grants broad table access to authenticated users.
-- These SECURITY DEFINER RPCs therefore enforce authentication and room
-- membership themselves instead of relying on the current table policies.

-- Existing active sessions may predate snapshot support. Give each one a
-- default state so get_playback_snapshot can return it immediately.
insert into public.playback_states (session_id)
select session.id
from public.watch_sessions as session
where session.status = 'active'
on conflict (session_id) do nothing;

create or replace function public.ensure_active_watch_session(
  p_room_id uuid,
  p_media_title text default null,
  p_media_fingerprint text default null,
  p_adapter_key text default null
)
returns table (
  session_id uuid,
  room_id uuid,
  status text,
  media_title text,
  media_fingerprint text,
  adapter_key text,
  started_by uuid,
  started_at timestamptz,
  media_time double precision,
  paused boolean,
  playback_rate double precision,
  revision bigint,
  updated_by uuid,
  updated_at timestamptz,
  server_time timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_room_id uuid;
  v_session public.watch_sessions%rowtype;
  v_state public.playback_states%rowtype;
begin
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'authentication required';
  end if;

  if p_room_id is null then
    raise exception using
      errcode = '22023',
      message = 'room id is required';
  end if;

  if not public.is_room_member(p_room_id) then
    raise exception using
      errcode = '42501',
      message = 'room membership required';
  end if;

  -- Serialise session creation per room. The partial unique index remains a
  -- second line of defence for callers that still write to the table directly.
  select room.id
  into v_room_id
  from public.rooms as room
  where room.id = p_room_id
    and room.archived_at is null
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'room is unavailable';
  end if;

  select session.*
  into v_session
  from public.watch_sessions as session
  where session.room_id = p_room_id
    and session.status = 'active'
  order by session.started_at desc
  limit 1
  for update;

  -- A room can switch to a different video without being recreated. Rotate
  -- the active session when a concrete fingerprint changes; otherwise enrich
  -- the existing session with metadata learned after initial discovery.
  if found then
    if nullif(btrim(p_media_fingerprint), '') is not null
      and v_session.media_fingerprint is not null
      and nullif(btrim(p_media_fingerprint), '') is distinct from v_session.media_fingerprint then
      update public.watch_sessions as session
      set
        status = 'ended',
        ended_at = clock_timestamp()
      where session.id = v_session.id;
      v_session.id := null;
    else
      update public.watch_sessions as session
      set
        media_title = coalesce(nullif(btrim(p_media_title), ''), session.media_title),
        media_fingerprint = coalesce(nullif(btrim(p_media_fingerprint), ''), session.media_fingerprint),
        adapter_key = coalesce(nullif(btrim(p_adapter_key), ''), session.adapter_key)
      where session.id = v_session.id
      returning session.*
      into v_session;
    end if;
  end if;

  if v_session.id is null then
    insert into public.watch_sessions (
      room_id,
      started_by,
      status,
      media_title,
      media_fingerprint,
      adapter_key
    )
    values (
      p_room_id,
      v_user_id,
      'active',
      nullif(btrim(p_media_title), ''),
      nullif(btrim(p_media_fingerprint), ''),
      nullif(btrim(p_adapter_key), '')
    )
    on conflict do nothing
    returning *
    into v_session;

    -- A direct table writer can win the unique-index race without taking the
    -- room lock. Acquire and return that valid active session in that case.
    if not found then
      select session.*
      into v_session
      from public.watch_sessions as session
      where session.room_id = p_room_id
        and session.status = 'active'
      order by session.started_at desc
      limit 1
      for update;
    end if;
  end if;

  if v_session.id is null then
    raise exception using
      errcode = '55000',
      message = 'active watch session could not be acquired';
  end if;

  insert into public.playback_states (
    session_id,
    media_time,
    paused,
    playback_rate,
    revision,
    updated_by
  )
  values (
    v_session.id,
    0,
    true,
    1,
    0,
    v_user_id
  )
  on conflict on constraint playback_states_pkey do nothing;

  select state.*
  into v_state
  from public.playback_states as state
  where state.session_id = v_session.id
  for update;

  return query
  select
    v_session.id,
    v_session.room_id,
    v_session.status,
    v_session.media_title,
    v_session.media_fingerprint,
    v_session.adapter_key,
    v_session.started_by,
    v_session.started_at,
    v_state.media_time,
    v_state.paused,
    v_state.playback_rate,
    v_state.revision,
    v_state.updated_by,
    v_state.updated_at,
    clock_timestamp();
end;
$$;

create or replace function public.get_playback_snapshot(p_room_id uuid)
returns table (
  session_id uuid,
  room_id uuid,
  status text,
  media_title text,
  media_fingerprint text,
  adapter_key text,
  started_by uuid,
  started_at timestamptz,
  media_time double precision,
  paused boolean,
  playback_rate double precision,
  revision bigint,
  updated_by uuid,
  updated_at timestamptz,
  server_time timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'authentication required';
  end if;

  if p_room_id is null then
    raise exception using
      errcode = '22023',
      message = 'room id is required';
  end if;

  if not public.is_room_member(p_room_id) then
    raise exception using
      errcode = '42501',
      message = 'room membership required';
  end if;

  return query
  select
    session.id,
    session.room_id,
    session.status,
    session.media_title,
    session.media_fingerprint,
    session.adapter_key,
    session.started_by,
    session.started_at,
    state.media_time,
    state.paused,
    state.playback_rate,
    state.revision,
    state.updated_by,
    state.updated_at,
    clock_timestamp()
  from public.watch_sessions as session
  join public.playback_states as state
    on state.session_id = session.id
  where session.room_id = p_room_id
    and session.status = 'active'
  order by session.started_at desc
  limit 1;
end;
$$;

create or replace function public.update_playback_snapshot(
  p_room_id uuid,
  p_session_id uuid,
  p_media_time double precision,
  p_paused boolean,
  p_playback_rate double precision,
  p_expected_revision bigint default null
)
returns table (
  applied boolean,
  session_id uuid,
  room_id uuid,
  status text,
  media_title text,
  media_fingerprint text,
  adapter_key text,
  started_by uuid,
  started_at timestamptz,
  media_time double precision,
  paused boolean,
  playback_rate double precision,
  revision bigint,
  updated_by uuid,
  updated_at timestamptz,
  server_time timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session public.watch_sessions%rowtype;
  v_state public.playback_states%rowtype;
begin
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'authentication required';
  end if;

  if p_room_id is null or p_session_id is null then
    raise exception using
      errcode = '22023',
      message = 'room id and session id are required';
  end if;

  if not public.is_room_member(p_room_id) then
    raise exception using
      errcode = '42501',
      message = 'room membership required';
  end if;

  -- The explicit infinity comparison also rejects PostgreSQL NaN, which sorts
  -- above finite floating-point values.
  if p_media_time is null
    or not (
      p_media_time >= 0
      and p_media_time < 'Infinity'::double precision
    ) then
    raise exception using
      errcode = '22023',
      message = 'media time must be a finite non-negative number';
  end if;

  if p_paused is null then
    raise exception using
      errcode = '22023',
      message = 'paused state is required';
  end if;

  if p_playback_rate is null
    or not (p_playback_rate between 0.25 and 4) then
    raise exception using
      errcode = '22023',
      message = 'playback rate must be between 0.25 and 4';
  end if;

  if p_expected_revision is not null and p_expected_revision < 0 then
    raise exception using
      errcode = '22023',
      message = 'expected revision cannot be negative';
  end if;

  -- Lock the active session so it cannot be ended while its state is updated.
  select session.*
  into v_session
  from public.watch_sessions as session
  where session.id = p_session_id
    and session.room_id = p_room_id
    and session.status = 'active'
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'active watch session not found for room';
  end if;

  -- Repair sessions created by an older or direct-table client.
  insert into public.playback_states (
    session_id,
    media_time,
    paused,
    playback_rate,
    revision,
    updated_by
  )
  values (
    v_session.id,
    0,
    true,
    1,
    0,
    v_user_id
  )
  on conflict on constraint playback_states_pkey do nothing;

  -- The row lock makes the comparison and revision increment atomic across all
  -- room members. A rejected compare-and-set returns the current state so the
  -- caller can re-sync without making a second request.
  select state.*
  into v_state
  from public.playback_states as state
  where state.session_id = v_session.id
  for update;

  if p_expected_revision is not null
    and p_expected_revision <> v_state.revision then
    return query
    select
      false,
      v_session.id,
      v_session.room_id,
      v_session.status,
      v_session.media_title,
      v_session.media_fingerprint,
      v_session.adapter_key,
      v_session.started_by,
      v_session.started_at,
      v_state.media_time,
      v_state.paused,
      v_state.playback_rate,
      v_state.revision,
      v_state.updated_by,
      v_state.updated_at,
      clock_timestamp();
    return;
  end if;

  update public.playback_states as state
  set
    media_time = p_media_time,
    paused = p_paused,
    playback_rate = p_playback_rate,
    revision = state.revision + 1,
    updated_by = v_user_id
  where state.session_id = v_session.id
  returning state.*
  into v_state;

  return query
  select
    true,
    v_session.id,
    v_session.room_id,
    v_session.status,
    v_session.media_title,
    v_session.media_fingerprint,
    v_session.adapter_key,
    v_session.started_by,
    v_session.started_at,
    v_state.media_time,
    v_state.paused,
    v_state.playback_rate,
    v_state.revision,
    v_state.updated_by,
    v_state.updated_at,
    clock_timestamp();
end;
$$;

revoke all privileges
  on function public.ensure_active_watch_session(uuid, text, text, text)
  from public, anon;
revoke all privileges
  on function public.get_playback_snapshot(uuid)
  from public, anon;
revoke all privileges
  on function public.update_playback_snapshot(
    uuid,
    uuid,
    double precision,
    boolean,
    double precision,
    bigint
  )
  from public, anon;

grant execute
  on function public.ensure_active_watch_session(uuid, text, text, text)
  to authenticated;
grant execute
  on function public.get_playback_snapshot(uuid)
  to authenticated;
grant execute
  on function public.update_playback_snapshot(
    uuid,
    uuid,
    double precision,
    boolean,
    double precision,
    bigint
  )
  to authenticated;

notify pgrst, 'reload schema';
