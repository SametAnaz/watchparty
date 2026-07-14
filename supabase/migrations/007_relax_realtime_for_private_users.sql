-- Only manually provisioned users can authenticate in this private project.
-- Keep channels private, but let every authenticated user exchange Broadcast
-- and Presence messages without an additional room-membership policy lookup.
drop policy if exists "room members can receive room realtime" on realtime.messages;
drop policy if exists "room members can send room realtime" on realtime.messages;

create policy "authenticated users can receive realtime"
  on realtime.messages
  for select
  to authenticated
  using (realtime.messages.extension in ('broadcast', 'presence'));

create policy "authenticated users can send realtime"
  on realtime.messages
  for insert
  to authenticated
  with check (realtime.messages.extension in ('broadcast', 'presence'));

notify pgrst, 'reload schema';
