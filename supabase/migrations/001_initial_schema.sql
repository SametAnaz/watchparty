create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Accounts are created manually in Supabase Auth. Any authenticated account
-- can discover the other approved profiles and create a two-person room.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.watch_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  started_by uuid not null references auth.users (id) on delete restrict,
  status text not null check (status in ('active', 'ended')),
  media_title text,
  media_fingerprint text,
  adapter_key text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  check (
    (status = 'active' and ended_at is null)
    or (status = 'ended' and ended_at is not null and ended_at >= started_at)
  )
);

create table if not exists public.playback_states (
  session_id uuid primary key references public.watch_sessions (id) on delete cascade,
  media_time double precision not null default 0 check (media_time >= 0),
  paused boolean not null default true,
  playback_rate double precision not null default 1 check (playback_rate between 0.25 and 4),
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  session_id uuid references public.watch_sessions (id) on delete set null,
  sender_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('text', 'system', 'session_started', 'session_ended', 'media_changed')),
  body text check (
    (type = 'text' and char_length(btrim(coalesce(body, ''))) between 1 and 4000)
    or (type <> 'text' and (body is null or char_length(btrim(body)) <= 4000))
  ),
  reply_to uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index if not exists watch_sessions_room_started_at_idx
  on public.watch_sessions (room_id, started_at desc);
create unique index if not exists one_active_watch_session_per_room_idx
  on public.watch_sessions (room_id) where status = 'active';
create index if not exists messages_room_created_at_idx
  on public.messages (room_id, created_at desc);
create index if not exists messages_session_created_at_idx
  on public.messages (session_id, created_at desc) where session_id is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rooms_set_updated_at
  before update on public.rooms
  for each row execute function public.set_updated_at();

create or replace function public.protect_room_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'room owner cannot be changed';
  end if;
  return new;
end;
$$;

create trigger rooms_protect_owner
  before update on public.rooms
  for each row execute function public.protect_room_owner();

create or replace function public.protect_watch_session_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.room_id is distinct from old.room_id
    or new.started_by is distinct from old.started_by
    or new.started_at is distinct from old.started_at then
    raise exception 'watch session identity cannot be changed';
  end if;
  return new;
end;
$$;

create trigger watch_sessions_protect_identity
  before update on public.watch_sessions
  for each row execute function public.protect_watch_session_identity();

create or replace function public.protect_playback_state_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.session_id is distinct from old.session_id then
    raise exception 'playback state session cannot be changed';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger playback_states_protect_identity
  before update on public.playback_states
  for each row execute function public.protect_playback_state_identity();

create or replace function public.validate_message_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.room_id is distinct from old.room_id
    or new.session_id is distinct from old.session_id
    or new.sender_id is distinct from old.sender_id
    or new.type is distinct from old.type
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'message identity cannot be changed';
  end if;

  if new.session_id is not null then
    select room_id into v_room_id from public.watch_sessions where id = new.session_id;
    if v_room_id is distinct from new.room_id then
      raise exception 'message session must belong to its room';
    end if;
  end if;

  if new.reply_to is not null then
    select room_id into v_room_id from public.messages where id = new.reply_to;
    if v_room_id is distinct from new.room_id then
      raise exception 'reply target must belong to the same room';
    end if;
  end if;

  if tg_op = 'UPDATE' and new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create trigger messages_validate_scope
  before insert or update on public.messages
  for each row execute function public.validate_message_scope();

create table if not exists public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.watch_sessions enable row level security;
alter table public.playback_states enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;

-- This function intentionally bypasses RLS while checking membership. A
-- room_members policy cannot query room_members directly without recursion.
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = p_room_id
      and user_id = (select auth.uid())
  );
$$;

-- RLS decides which rows an authenticated user may access; these grants allow
-- the PostgREST authenticated role to reach the tables in the first place.
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, update on public.rooms to authenticated;
grant select on public.room_members to authenticated;
grant select, insert, update on public.watch_sessions to authenticated;
grant select, insert, update on public.playback_states to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert, update on public.message_reads to authenticated;

create policy "approved users can discover profiles" on public.profiles
  for select to authenticated using (true);

create policy "authenticated users can create profiles" on public.profiles
  for insert with check (id = auth.uid());

create policy "profiles self update" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy "room members can update rooms" on public.rooms
  for update using (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = rooms.id
        and rm.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = rooms.id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can read rooms" on public.rooms
  for select using (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = rooms.id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can read membership" on public.room_members
  for select using (public.is_room_member(room_id));

create policy "room members can read sessions" on public.watch_sessions
  for select using (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = watch_sessions.room_id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can create sessions" on public.watch_sessions
  for insert with check (
    started_by = auth.uid()
    and exists (
      select 1
      from public.room_members rm
      where rm.room_id = watch_sessions.room_id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can update sessions" on public.watch_sessions
  for update using (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = watch_sessions.room_id
        and rm.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = watch_sessions.room_id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can read playback state" on public.playback_states
  for select using (
    exists (
      select 1
      from public.watch_sessions ws
      join public.room_members rm on rm.room_id = ws.room_id
      where ws.id = playback_states.session_id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can write playback state" on public.playback_states
  for insert with check (
    exists (
      select 1
      from public.watch_sessions ws
      join public.room_members rm on rm.room_id = ws.room_id
      where ws.id = playback_states.session_id
        and rm.user_id = auth.uid()
    )
    and updated_by = (select auth.uid())
  );

create policy "room members can update playback state" on public.playback_states
  for update using (
    exists (
      select 1
      from public.watch_sessions ws
      join public.room_members rm on rm.room_id = ws.room_id
      where ws.id = playback_states.session_id
        and rm.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
      from public.watch_sessions ws
      join public.room_members rm on rm.room_id = ws.room_id
      where ws.id = playback_states.session_id
        and rm.user_id = auth.uid()
    )
    and updated_by = (select auth.uid())
  );

create policy "room members can read messages" on public.messages
  for select using (
    exists (
      select 1
      from public.room_members rm
      where rm.room_id = messages.room_id
        and rm.user_id = auth.uid()
    )
  );

create policy "room members can insert messages" on public.messages
  for insert with check (
    sender_id = auth.uid()
    and type = 'text'
    and exists (
      select 1
      from public.room_members rm
      where rm.room_id = messages.room_id
        and rm.user_id = auth.uid()
    )
  );

create policy "message authors can update messages" on public.messages
  for update using (sender_id = (select auth.uid()))
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.room_members rm
      where rm.room_id = messages.room_id and rm.user_id = (select auth.uid())
    )
  );

create policy "room members can read reads" on public.message_reads
  for select using (
    exists (
      select 1
      from public.messages m
      join public.room_members rm on rm.room_id = m.room_id
      where m.id = message_reads.message_id
        and rm.user_id = auth.uid()
    )
  );

create policy "users can mark their own reads" on public.message_reads
  for insert with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      join public.room_members rm on rm.room_id = m.room_id
      where m.id = message_reads.message_id and rm.user_id = (select auth.uid())
    )
  );

create policy "users can update their own reads" on public.message_reads
  for update using (user_id = (select auth.uid())) with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      join public.room_members rm on rm.room_id = m.room_id
      where m.id = message_reads.message_id and rm.user_id = (select auth.uid())
    )
  );

create or replace function public.create_room(p_name text, p_member_id uuid)
returns table(room_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_id uuid := extensions.gen_random_uuid();
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required';
  end if;

  if char_length(btrim(p_name)) not between 1 and 80 then
    raise exception 'room name must be between 1 and 80 characters';
  end if;

  if p_member_id = (select auth.uid()) then
    raise exception 'choose a different room member';
  end if;

  if not exists (select 1 from public.profiles where id = p_member_id) then
    raise exception 'selected user does not exist';
  end if;

  insert into public.rooms (id, name, created_by)
  values (v_room_id, btrim(p_name), (select auth.uid()));

  insert into public.room_members (room_id, user_id)
  values
    (v_room_id, (select auth.uid())),
    (v_room_id, p_member_id);

  return query
  select v_room_id;
end;
$$;

-- Room data and its low-latency events use the same private topic.
-- The client must subscribe with { config: { private: true } }.
create policy "room members can receive room realtime" on realtime.messages
  for select to authenticated using (
    realtime.messages.extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.room_members rm
      where rm.room_id::text = split_part((select realtime.topic()), ':', 2)
        and (select realtime.topic()) = 'room:' || rm.room_id::text
        and rm.user_id = (select auth.uid())
    )
  );

create policy "room members can send room realtime" on realtime.messages
  for insert to authenticated with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.room_members rm
      where rm.room_id::text = split_part((select realtime.topic()), ':', 2)
        and (select realtime.topic()) = 'room:' || rm.room_id::text
        and rm.user_id = (select auth.uid())
    )
  );

create or replace function public.broadcast_message_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_id uuid := coalesce(new.room_id, old.room_id);
begin
  perform realtime.broadcast_changes(
    'room:' || v_room_id::text,
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

create trigger messages_broadcast_changes
  after insert or update or delete on public.messages
  for each row execute function public.broadcast_message_change();

revoke execute on function public.create_room(text, uuid) from public, anon;
grant execute on function public.create_room(text, uuid) to authenticated;
