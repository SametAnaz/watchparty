-- A policy on room_members previously queried room_members directly, which
-- causes PostgreSQL error 42P17 (infinite recursion detected in policy).
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

drop policy if exists "room members can read membership" on public.room_members;

create policy "room members can read membership" on public.room_members
  for select using (public.is_room_member(room_id));
