begin;

create table public.yunuf_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  status text not null default 'lobby' check (status in ('lobby','playing','finishing_round_after_show','hand_results','match_over')),
  host_player_id uuid,
  version integer not null default 1 check (version > 0),
  elimination_score integer not null default 100 check (elimination_score between 25 and 500),
  turn_duration_seconds integer not null default 30 check (turn_duration_seconds between 15 and 120),
  game_state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.yunuf_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.yunuf_rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  avatar integer not null default 0 check (avatar between 0 and 3),
  seat integer not null check (seat between 1 and 5),
  role text not null check (role in ('host','guest')),
  token_hash text not null check (char_length(token_hash) = 64),
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  unique(room_id, seat)
);

alter table public.yunuf_rooms
  add constraint yunuf_rooms_host_fk foreign key (host_player_id) references public.yunuf_players(id) on delete set null;

create index yunuf_players_room_idx on public.yunuf_players(room_id, seat);
create index yunuf_rooms_updated_idx on public.yunuf_rooms(updated_at);

create table public.processed_yunuf_actions (
  id uuid primary key,
  room_id uuid not null references public.yunuf_rooms(id) on delete cascade,
  player_id uuid not null references public.yunuf_players(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index processed_yunuf_actions_room_idx on public.processed_yunuf_actions(room_id, created_at);

create or replace function public.validate_yunuf_player_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_count integer;
begin
  select status into v_status from public.yunuf_rooms where id = new.room_id for update;
  if not found then raise exception 'YUNUF_404|Room not found'; end if;
  if v_status <> 'lobby' then raise exception 'YUNUF_409|That match has already started'; end if;
  select count(*) into v_count from public.yunuf_players where room_id = new.room_id;
  if v_count >= 5 then raise exception 'YUNUF_409|This room is full'; end if;
  return new;
end;
$$;

create trigger yunuf_player_limit_before_insert
before insert on public.yunuf_players
for each row execute function public.validate_yunuf_player_limit();

create or replace function public.bump_yunuf_lobby_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.yunuf_rooms set version = version + 1, updated_at = now() where id = new.room_id;
  return new;
end;
$$;

create trigger yunuf_player_bump_room_after_insert
after insert on public.yunuf_players
for each row execute function public.bump_yunuf_lobby_version();

create or replace function public.touch_yunuf_lobby(p_room_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_version integer;
begin
  update public.yunuf_rooms set version = version + 1, updated_at = now()
  where id = p_room_id and status = 'lobby'
  returning version into v_version;
  if not found then raise exception 'YUNUF_409|The match has already started'; end if;
  return v_version;
end;
$$;

create or replace function public.commit_yunuf_action(
  p_room_id uuid,
  p_player_id uuid,
  p_action_id uuid,
  p_expected_version integer,
  p_status text,
  p_state jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.yunuf_rooms%rowtype;
  v_result jsonb;
begin
  select result into v_result from public.processed_yunuf_actions
  where id = p_action_id and room_id = p_room_id and player_id = p_player_id;
  if found then return v_result; end if;

  select * into v_room from public.yunuf_rooms where id = p_room_id for update;
  if not found then raise exception 'YUNUF_404|Room not found'; end if;
  if not exists (select 1 from public.yunuf_players where id = p_player_id and room_id = p_room_id) then
    raise exception 'YUNUF_401|Your room session is no longer valid';
  end if;
  if v_room.version <> p_expected_version then
    raise exception 'YUNUF_409|The game changed. Refreshing the latest turn.';
  end if;
  if p_status not in ('lobby','playing','finishing_round_after_show','hand_results','match_over') then
    raise exception 'YUNUF_500|Invalid game status';
  end if;

  update public.yunuf_rooms
  set game_state = p_state, status = p_status, version = version + 1, updated_at = now()
  where id = p_room_id;

  v_result := jsonb_build_object('roomId', p_room_id, 'version', v_room.version + 1);
  insert into public.processed_yunuf_actions(id, room_id, player_id, result)
  values (p_action_id, p_room_id, p_player_id, v_result);
  return v_result;
end;
$$;

create or replace function public.cleanup_stale_yunuf_rooms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.yunuf_rooms where updated_at < now() - interval '7 days';
  return null;
end;
$$;

create trigger yunuf_rooms_cleanup_before_insert
before insert on public.yunuf_rooms
for each statement execute function public.cleanup_stale_yunuf_rooms();

alter table public.yunuf_rooms enable row level security;
alter table public.yunuf_players enable row level security;
alter table public.processed_yunuf_actions enable row level security;

revoke all on public.yunuf_rooms from anon, authenticated;
revoke all on public.yunuf_players from anon, authenticated;
revoke all on public.processed_yunuf_actions from anon, authenticated;
revoke all on function public.validate_yunuf_player_limit() from public, anon, authenticated;
revoke all on function public.bump_yunuf_lobby_version() from public, anon, authenticated;
revoke all on function public.touch_yunuf_lobby(uuid) from public, anon, authenticated;
revoke all on function public.cleanup_stale_yunuf_rooms() from public, anon, authenticated;
revoke all on function public.commit_yunuf_action(uuid, uuid, uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_yunuf_action(uuid, uuid, uuid, integer, text, jsonb) to service_role;
grant execute on function public.touch_yunuf_lobby(uuid) to service_role;

commit;
