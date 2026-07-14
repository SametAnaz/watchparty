-- The invite-code flow was removed in favour of direct two-person rooms.
-- Existing remote projects may still have this NOT NULL legacy column.
alter table public.rooms drop column if exists invite_hash;
notify pgrst, 'reload schema';
