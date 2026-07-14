# Samet Watchparty

Chrome extension + Supabase watchparty stack.

## Architecture

- Chrome extension UI lives in the side panel.
- Room, membership, chat, and session history are stored in Supabase Postgres.
- Playback control events are delivered through Supabase Realtime Broadcast.
- Online state uses Supabase Presence.
- Row Level Security restricts each room to its two members.

## Repo layout

- `apps/extension` - Chrome extension app
- `packages/protocol` - shared realtime event protocol
- `packages/shared-types` - shared data types
- `supabase` - database migrations and config
