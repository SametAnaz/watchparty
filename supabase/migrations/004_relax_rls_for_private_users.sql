-- This project has a manually managed, trusted user list. Keep RLS enabled
-- (so anonymous requests remain blocked), but remove per-room checks from the
-- authenticated experience. Do not grant these tables to anon.
drop policy if exists "approved users can discover profiles" on public.profiles;
drop policy if exists "authenticated users can create profiles" on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
drop policy if exists "room members can update rooms" on public.rooms;
drop policy if exists "room members can read rooms" on public.rooms;
drop policy if exists "room members can read membership" on public.room_members;
drop policy if exists "room members can read sessions" on public.watch_sessions;
drop policy if exists "room members can create sessions" on public.watch_sessions;
drop policy if exists "room members can update sessions" on public.watch_sessions;
drop policy if exists "room members can read playback state" on public.playback_states;
drop policy if exists "room members can write playback state" on public.playback_states;
drop policy if exists "room members can update playback state" on public.playback_states;
drop policy if exists "room members can read messages" on public.messages;
drop policy if exists "room members can insert messages" on public.messages;
drop policy if exists "message authors can update messages" on public.messages;
drop policy if exists "room members can read reads" on public.message_reads;
drop policy if exists "users can mark their own reads" on public.message_reads;
drop policy if exists "users can update their own reads" on public.message_reads;

create policy "authenticated full access" on public.profiles
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.rooms
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.room_members
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.watch_sessions
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.playback_states
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.messages
  for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.message_reads
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on all tables in schema public to authenticated;
