-- Upgrade projects that previously had create_room(p_name) with an invite-code
-- flow to the direct two-person room function used by the extension.
drop function if exists public.create_room(text);

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

  return query select v_room_id;
end;
$$;

revoke execute on function public.create_room(text, uuid) from public, anon;
grant execute on function public.create_room(text, uuid) to authenticated;
notify pgrst, 'reload schema';
