create extension if not exists pgcrypto;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'round_result', 'finished')),
  current_round smallint not null default 1 check (current_round in (1, 2)),
  current_word_index smallint not null default 0 check (current_word_index between 0 and 8),
  clues_used smallint not null default 0 check (clues_used between 0 and 15),
  round_ends_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  role text not null check (role in ('host', 'guest')),
  seat smallint not null check (seat in (1, 2)),
  avatar smallint not null default 0 check (avatar between 0 and 3),
  token_hash text not null,
  ready boolean not null default false,
  round1_score smallint not null default 0 check (round1_score between 0 and 8),
  round2_score smallint not null default 0 check (round2_score between 0 and 8),
  created_at timestamptz not null default now(),
  unique (room_id, seat),
  unique (room_id, role)
);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number smallint not null check (round_number in (1, 2)),
  giver_id uuid not null references public.players(id) on delete cascade,
  guesser_id uuid not null references public.players(id) on delete cascade,
  words text[] not null check (cardinality(words) = 8),
  statuses text[] not null default array['active','pending','pending','pending','pending','pending','pending','pending']::text[],
  latest_clue text,
  clues jsonb not null default '[]'::jsonb,
  score smallint not null default 0 check (score between 0 and 8),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  completed_at timestamptz,
  unique (room_id, round_number)
);

create index rooms_code_idx on public.rooms(code);
create index players_room_id_idx on public.players(room_id);
create index rounds_room_id_idx on public.rounds(room_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger rooms_set_updated_at before update on public.rooms
for each row execute function public.set_updated_at();

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.rounds enable row level security;

-- No policies are intentionally granted. Browsers use Realtime Presence/Broadcast,
-- while all persistent reads and writes pass through server-side Route Handlers.
-- The service role bypasses RLS; anon/authenticated roles cannot inspect game data.

revoke all on public.rooms from anon, authenticated;
revoke all on public.players from anon, authenticated;
revoke all on public.rounds from anon, authenticated;
