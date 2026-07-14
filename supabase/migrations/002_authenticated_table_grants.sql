-- Applies the authenticated-role grants to projects where 001 was deployed
-- before the grants were added to the initial migration.
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, update on public.rooms to authenticated;
grant select on public.room_members to authenticated;
grant select, insert, update on public.watch_sessions to authenticated;
grant select, insert, update on public.playback_states to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert, update on public.message_reads to authenticated;
