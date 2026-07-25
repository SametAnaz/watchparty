-- Restore room-scoped chat access after 004 intentionally granted every
-- authenticated user unrestricted access to the private project's tables.
-- Keep hard deletion of messages unavailable: the client uses deleted_at for
-- soft deletion instead.

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.watch_sessions enable row level security;
alter table public.playback_states enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.message_reactions enable row level security;

drop policy if exists "authenticated full access" on public.profiles;
drop policy if exists "approved users can discover profiles" on public.profiles;
drop policy if exists "authenticated users can create profiles" on public.profiles;
drop policy if exists "profiles self update" on public.profiles;

create policy "approved users can discover profiles"
  on public.profiles for select to authenticated
  using (true);
create policy "authenticated users can create profiles"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "profiles self update"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke delete on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;

drop policy if exists "authenticated full access" on public.rooms;
drop policy if exists "room members can read rooms" on public.rooms;
drop policy if exists "room members can update rooms" on public.rooms;

create policy "room members can read rooms"
  on public.rooms for select to authenticated
  using (public.is_room_member(id));

revoke insert, update, delete on public.rooms from authenticated;
grant select on public.rooms to authenticated;

drop policy if exists "authenticated full access" on public.room_members;
drop policy if exists "room members can read membership" on public.room_members;

create policy "room members can read membership"
  on public.room_members for select to authenticated
  using (public.is_room_member(room_id));

revoke insert, update, delete on public.room_members from authenticated;
grant select on public.room_members to authenticated;

drop policy if exists "authenticated full access" on public.watch_sessions;
drop policy if exists "authenticated full access" on public.playback_states;
drop policy if exists "room members can read sessions" on public.watch_sessions;
drop policy if exists "room members can read playback state" on public.playback_states;

create policy "room members can read sessions"
  on public.watch_sessions for select to authenticated
  using (public.is_room_member(room_id));
create policy "room members can read playback state"
  on public.playback_states for select to authenticated
  using (
    exists (
      select 1
      from public.watch_sessions session
      where session.id = playback_states.session_id
        and public.is_room_member(session.room_id)
    )
  );

revoke insert, update, delete on public.watch_sessions from authenticated;
revoke insert, update, delete on public.playback_states from authenticated;
grant select on public.watch_sessions, public.playback_states to authenticated;

drop policy if exists "authenticated full access" on public.messages;
drop policy if exists "room members can read messages" on public.messages;
drop policy if exists "room members can insert messages" on public.messages;
drop policy if exists "message authors can update messages" on public.messages;

create policy "room members can read messages"
  on public.messages
  for select
  to authenticated
  using (public.is_room_member(room_id));

create policy "room members can insert messages"
  on public.messages
  for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    and type = 'text'
    and public.is_room_member(room_id)
  );

create policy "message authors can update messages"
  on public.messages
  for update
  to authenticated
  using (
    sender_id = (select auth.uid())
    and public.is_room_member(room_id)
  )
  with check (
    sender_id = (select auth.uid())
    and public.is_room_member(room_id)
  );

revoke delete on public.messages from authenticated;
grant select, insert, update on public.messages to authenticated;

drop policy if exists "authenticated full access" on public.message_reads;
drop policy if exists "room members can read reads" on public.message_reads;
drop policy if exists "users can mark their own reads" on public.message_reads;
drop policy if exists "users can update their own reads" on public.message_reads;

create policy "room members can read reads"
  on public.message_reads
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages message
      where message.id = message_reads.message_id
        and public.is_room_member(message.room_id)
    )
  );

create policy "users can mark their own reads"
  on public.message_reads
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages message
      where message.id = message_reads.message_id
        and public.is_room_member(message.room_id)
    )
  );

create policy "users can update their own reads"
  on public.message_reads
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages message
      where message.id = message_reads.message_id
        and public.is_room_member(message.room_id)
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages message
      where message.id = message_reads.message_id
        and public.is_room_member(message.room_id)
    )
  );

revoke delete on public.message_reads from authenticated;
grant select, insert, update on public.message_reads to authenticated;

drop policy if exists "authenticated full access" on public.message_reactions;
drop policy if exists "room members can read reactions" on public.message_reactions;
drop policy if exists "users can add their own reactions" on public.message_reactions;
drop policy if exists "users can remove their own reactions" on public.message_reactions;

create policy "room members can read reactions"
  on public.message_reactions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.messages message
      where message.id = message_reactions.message_id
        and public.is_room_member(message.room_id)
    )
  );

create policy "users can add their own reactions"
  on public.message_reactions
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages message
      where message.id = message_reactions.message_id
        and public.is_room_member(message.room_id)
    )
  );

create policy "users can remove their own reactions"
  on public.message_reactions
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages message
      where message.id = message_reactions.message_id
        and public.is_room_member(message.room_id)
    )
  );

-- DELETE remains required for removing one's own reaction, but RLS now limits
-- it to that user's rows. Reactions never need UPDATE.
revoke update on public.message_reactions from authenticated;
grant select, insert, delete on public.message_reactions to authenticated;

-- Keep realtime room traffic private and authorize both the database-trigger
-- `room:<uuid>` topic and the extension's low-latency `live:<uuid>` topic.
drop policy if exists "authenticated users can receive realtime" on realtime.messages;
drop policy if exists "authenticated users can send realtime" on realtime.messages;
drop policy if exists "room members can receive room realtime" on realtime.messages;
drop policy if exists "room members can send room realtime" on realtime.messages;

create policy "room members can receive room realtime"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and exists (
      select 1
      from public.room_members member
      where member.user_id = (select auth.uid())
        and (
          (select realtime.topic()) = 'room:' || member.room_id::text
          or (select realtime.topic()) = 'live:' || member.room_id::text
        )
    )
  );

create policy "room members can send room realtime"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and exists (
      select 1
      from public.room_members member
      where member.user_id = (select auth.uid())
        and (
          (select realtime.topic()) = 'room:' || member.room_id::text
          or (select realtime.topic()) = 'live:' || member.room_id::text
        )
    )
  );

-- Only normal edits and a one-way soft-delete transition are valid message
-- mutations. This also prevents API clients from restoring deleted content or
-- rewriting reply metadata after creation.
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
    or new.reply_to is distinct from old.reply_to
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'message identity cannot be changed';
  end if;

  if tg_op = 'INSERT' and (new.edited_at is not null or new.deleted_at is not null) then
    raise exception 'new messages cannot be pre-edited or deleted';
  end if;

  if tg_op = 'UPDATE' and old.deleted_at is not null then
    raise exception 'deleted messages cannot be changed';
  end if;

  if tg_op = 'UPDATE' and new.deleted_at is distinct from old.deleted_at then
    if new.deleted_at is null or new.body is distinct from '[silindi]' then
      raise exception 'invalid message deletion';
    end if;
    new.deleted_at := now();
    new.edited_at := now();
  elsif tg_op = 'UPDATE' and new.edited_at is distinct from old.edited_at then
    raise exception 'edited timestamp is managed by the server';
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

notify pgrst, 'reload schema';
