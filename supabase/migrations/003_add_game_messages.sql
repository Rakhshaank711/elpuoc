create table public.game_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  round_number smallint not null check (round_number in (1, 2)),
  word_index smallint not null check (word_index between 0 and 7),
  sender_id uuid references public.players(id) on delete set null,
  type text not null check (type in ('clue', 'guess', 'wrong', 'correct', 'clue_request', 'clue_offer', 'skipped')),
  body text check (body is null or char_length(body) <= 100),
  word_count smallint not null default 0 check (word_count between 0 and 15),
  created_at timestamptz not null default now()
);

create index game_messages_room_round_idx
on public.game_messages(room_id, round_number, created_at);

alter table public.game_messages enable row level security;
revoke all on public.game_messages from anon, authenticated;
