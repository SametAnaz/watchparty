-- A reaction is social feedback from another room member; authors cannot react
-- to their own messages. Clean up any existing self-reactions before enforcing
-- the invariant for all API clients.
delete from public.message_reactions reaction
using public.messages message
where message.id = reaction.message_id
  and message.sender_id = reaction.user_id;

create or replace function public.prevent_self_message_reaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.messages
    where id = new.message_id
      and sender_id = new.user_id
  ) then
    raise exception 'users cannot react to their own messages';
  end if;
  return new;
end;
$$;

drop trigger if exists message_reactions_prevent_self on public.message_reactions;
create trigger message_reactions_prevent_self
  before insert or update on public.message_reactions
  for each row execute function public.prevent_self_message_reaction();
