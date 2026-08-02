-- Serialise every room mutation in one transaction and make client retries safe.
begin;

alter table public.rounds
  add constraint rounds_distinct_roles check (giver_id <> guesser_id),
  add constraint rounds_statuses_valid check (
    cardinality(statuses) = 8
    and statuses <@ array['active','pending','guessed','skipped']::text[]
  ),
  add constraint rounds_latest_clue_length check (latest_clue is null or char_length(latest_clue) <= 100);

create or replace function public.validate_room_references()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'rounds' then
    if not exists (select 1 from public.players where id = new.giver_id and room_id = new.room_id)
       or not exists (select 1 from public.players where id = new.guesser_id and room_id = new.room_id) then
      raise exception 'Round players must belong to the room';
    end if;
  elsif tg_table_name = 'game_messages' and new.sender_id is not null then
    if not exists (select 1 from public.players where id = new.sender_id and room_id = new.room_id) then
      raise exception 'Message sender must belong to the room';
    end if;
  end if;
  return new;
end;
$$;

create trigger rounds_validate_room_references
before insert or update on public.rounds
for each row execute function public.validate_room_references();

create trigger game_messages_validate_room_references
before insert or update on public.game_messages
for each row execute function public.validate_room_references();

revoke all on function public.validate_room_references() from public, anon, authenticated;

create table public.processed_game_actions (
  id uuid primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index processed_game_actions_room_idx
on public.processed_game_actions(room_id, created_at);
create index processed_game_actions_player_idx
on public.processed_game_actions(player_id, created_at);

alter table public.processed_game_actions enable row level security;
revoke all on public.processed_game_actions from anon, authenticated;

create table public.api_rate_limits (
  key text primary key,
  window_started_at timestamptz not null,
  hits integer not null check (hits > 0)
);

alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from anon, authenticated;

create or replace function public.consume_api_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_hits integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    return false;
  end if;

  insert into public.api_rate_limits as limits(key, window_started_at, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
  set window_started_at = case
        when limits.window_started_at <= v_now - make_interval(secs => p_window_seconds) then v_now
        else limits.window_started_at
      end,
      hits = case
        when limits.window_started_at <= v_now - make_interval(secs => p_window_seconds) then 1
        else limits.hits + 1
      end
  returning hits into v_hits;

  if random() < 0.01 then
    delete from public.api_rate_limits
    where window_started_at < v_now - interval '2 days';
  end if;

  return v_hits <= p_limit;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer) to service_role;

create or replace function public.cleanup_stale_rooms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.rooms where updated_at < now() - interval '7 days';
  return null;
end;
$$;

create trigger rooms_cleanup_before_insert
before insert on public.rooms
for each statement execute function public.cleanup_stale_rooms();

revoke all on function public.cleanup_stale_rooms() from public, anon, authenticated;

create or replace function public.get_game_state(
  p_code text,
  p_player_id uuid,
  p_token text
) returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
  v_round public.rounds%rowtype;
  v_players jsonb;
  v_messages jsonb := '[]'::jsonb;
  v_round_json jsonb := null;
  v_reveal_words boolean := false;
begin
  select * into v_player from public.players where id = p_player_id;
  if not found or encode(extensions.digest(p_token, 'sha256'), 'hex') <> v_player.token_hash then
    raise exception 'GAME_401|Your room session is no longer valid';
  end if;
  select * into v_room from public.rooms where code = upper(p_code);
  if not found then raise exception 'GAME_404|Room not found'; end if;
  if v_player.room_id <> v_room.id then raise exception 'GAME_401|Your room session is no longer valid'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'role', role, 'avatar', avatar, 'ready', ready,
    'round1Score', round1_score, 'round2Score', round2_score
  ) order by seat), '[]'::jsonb) into v_players
  from public.players where room_id = v_room.id;

  if v_room.status <> 'lobby' then
    select * into v_round from public.rounds
    where room_id = v_room.id and round_number = v_room.current_round;
    if not found then raise exception 'GAME_500|Round data is missing'; end if;
    v_reveal_words := v_round.giver_id = v_player.id or v_room.status <> 'playing';

    select coalesce(jsonb_agg(
      jsonb_build_object('index', ordinal - 1, 'status', v_round.statuses[ordinal])
      || case when v_reveal_words then jsonb_build_object('word', word) else '{}'::jsonb end
      order by ordinal
    ), '[]'::jsonb) into v_round_json
    from unnest(v_round.words) with ordinality as words(word, ordinal);

    v_round_json := jsonb_build_object(
      'giverId', v_round.giver_id, 'guesserId', v_round.guesser_id,
      'latestClue', v_round.latest_clue, 'score', v_round.score, 'words', v_round_json
    );

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'senderId', sender_id, 'wordIndex', word_index, 'type', type,
      'body', body, 'wordCount', word_count, 'createdAt', created_at
    ) order by created_at, id), '[]'::jsonb) into v_messages
    from public.game_messages
    where room_id = v_room.id and round_number = v_room.current_round;
  end if;

  return jsonb_build_object(
    'roomId', v_room.id, 'code', v_room.code, 'status', v_room.status,
    'currentRound', v_room.current_round, 'currentWordIndex', v_room.current_word_index,
    'cluesUsed', v_room.clues_used, 'clueLimit', 15, 'version', v_room.version,
    'messages', v_messages, 'players', v_players,
    'you', jsonb_build_object(
      'id', v_player.id, 'role', v_player.role,
      'roundRole', case when v_round.id is null then null when v_round.giver_id = v_player.id then 'giver' else 'guesser' end
    ),
    'round', v_round_json
  );
end;
$$;

revoke all on function public.get_game_state(text, uuid, text) from public, anon, authenticated;
grant execute on function public.get_game_state(text, uuid, text) to service_role;

create or replace function public.mutate_game(
  p_code text,
  p_player_id uuid,
  p_token text,
  p_action_id uuid,
  p_action text,
  p_text text default null,
  p_ready boolean default null,
  p_word_count integer default null,
  p_words text[] default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_player public.players%rowtype;
  v_round public.rounds%rowtype;
  v_cached jsonb;
  v_result jsonb;
  v_answer text;
  v_statuses text[];
  v_score integer;
  v_next_index integer;
  v_giver_id uuid;
  v_guesser_id uuid;
  v_all_ready boolean;
  v_player_count integer;
begin
  select * into v_player from public.players where id = p_player_id;
  if not found or encode(extensions.digest(p_token, 'sha256'), 'hex') <> v_player.token_hash then
    raise exception 'GAME_401|Your room session is no longer valid';
  end if;

  select * into v_room from public.rooms where code = upper(p_code) for update;
  if not found then raise exception 'GAME_404|Room not found'; end if;
  if v_player.room_id <> v_room.id then
    raise exception 'GAME_401|Your room session is no longer valid';
  end if;

  select result into v_cached
  from public.processed_game_actions
  where id = p_action_id and room_id = v_room.id and player_id = v_player.id;
  if found then return v_cached; end if;

  if (select count(*) from public.processed_game_actions
      where player_id = v_player.id and created_at > now() - interval '1 minute') >= 60 then
    raise exception 'GAME_429|Too many actions — take a short pause';
  end if;

  if p_action = 'ready' then
    if v_room.status <> 'lobby' then raise exception 'GAME_409|The game has already started'; end if;
    update public.players set ready = coalesce(p_ready, false) where id = v_player.id;
    select count(*), coalesce(bool_and(ready), false) into v_player_count, v_all_ready
    from public.players where room_id = v_room.id;
    if v_player_count = 2 and v_all_ready then
      if p_words is null or cardinality(p_words) <> 8 then raise exception 'GAME_500|Could not prepare the round'; end if;
      select id into v_giver_id from public.players where room_id = v_room.id order by seat limit 1;
      select id into v_guesser_id from public.players where room_id = v_room.id order by seat desc limit 1;
      insert into public.rounds(room_id, round_number, giver_id, guesser_id, words)
      values(v_room.id, 1, v_giver_id, v_guesser_id, p_words);
      update public.players set ready = false where room_id = v_room.id;
      update public.rooms set status = 'playing', current_round = 1, current_word_index = 0,
        clues_used = 0, version = version + 1 where id = v_room.id returning * into v_room;
    else
      update public.rooms set version = version + 1 where id = v_room.id returning * into v_room;
    end if;

  elsif p_action = 'continue' then
    if v_room.status <> 'round_result' then raise exception 'GAME_409|This round is not over yet'; end if;
    update public.players set ready = true where id = v_player.id;
    select count(*), coalesce(bool_and(ready), false) into v_player_count, v_all_ready
    from public.players where room_id = v_room.id;
    if v_player_count = 2 and v_all_ready and v_room.current_round = 1 then
      if p_words is null or cardinality(p_words) <> 8 then raise exception 'GAME_500|Could not prepare the round'; end if;
      select id into v_giver_id from public.players where room_id = v_room.id order by seat desc limit 1;
      select id into v_guesser_id from public.players where room_id = v_room.id order by seat limit 1;
      insert into public.rounds(room_id, round_number, giver_id, guesser_id, words)
      values(v_room.id, 2, v_giver_id, v_guesser_id, p_words);
      update public.players set ready = false where room_id = v_room.id;
      update public.rooms set status = 'playing', current_round = 2, current_word_index = 0,
        clues_used = 0, version = version + 1 where id = v_room.id returning * into v_room;
    elsif v_player_count = 2 and v_all_ready then
      update public.players set ready = false where room_id = v_room.id;
      update public.rooms set status = 'finished', version = version + 1
      where id = v_room.id returning * into v_room;
    else
      update public.rooms set version = version + 1 where id = v_room.id returning * into v_room;
    end if;

  elsif p_action = 'play_again' then
    if v_room.status <> 'finished' then raise exception 'GAME_409|Finish this game first'; end if;
    update public.players set ready = true where id = v_player.id;
    select count(*), coalesce(bool_and(ready), false) into v_player_count, v_all_ready
    from public.players where room_id = v_room.id;
    if v_player_count = 2 and v_all_ready then
      delete from public.rounds where room_id = v_room.id;
      delete from public.game_messages where room_id = v_room.id;
      update public.players set ready = false, round1_score = 0, round2_score = 0 where room_id = v_room.id;
      update public.rooms set status = 'lobby', current_round = 1, current_word_index = 0,
        clues_used = 0, version = version + 1 where id = v_room.id returning * into v_room;
    else
      update public.rooms set version = version + 1 where id = v_room.id returning * into v_room;
    end if;

  else
    if v_room.status <> 'playing' then raise exception 'GAME_409|The round is not active'; end if;
    select * into v_round from public.rounds
      where room_id = v_room.id and round_number = v_room.current_round;
    if not found then raise exception 'GAME_500|Round data is missing'; end if;
    v_answer := v_round.words[v_room.current_word_index + 1];

    if p_action in ('clue_request', 'clue_offer') then
      if p_action = 'clue_request' and v_round.guesser_id <> v_player.id then
        raise exception 'GAME_403|Only the guesser can request another clue';
      end if;
      if p_action = 'clue_offer' and v_round.giver_id <> v_player.id then
        raise exception 'GAME_403|Only the clue giver can offer another clue';
      end if;
      insert into public.game_messages(room_id, round_number, word_index, sender_id, type, body)
      values(v_room.id, v_room.current_round, v_room.current_word_index, v_player.id, p_action,
        case when p_action = 'clue_request' then 'Another clue, please?' else 'Want another clue?' end);
      update public.rooms set version = version + 1 where id = v_room.id returning * into v_room;

    elsif p_action = 'clue' then
      if v_round.giver_id <> v_player.id then raise exception 'GAME_403|Only the clue giver can send clues'; end if;
      if p_text is null or p_word_count is null or p_word_count < 1 or v_room.clues_used + p_word_count > 15 then
        raise exception 'GAME_400|That clue exceeds the remaining clue-word limit';
      end if;
      if regexp_replace(lower(p_text), '[^a-z0-9]', '', 'g') like '%' || regexp_replace(lower(v_answer), '[^a-z0-9]', '', 'g') || '%' then
        raise exception 'GAME_400|Your clue cannot contain the secret word';
      end if;
      update public.rooms set clues_used = clues_used + p_word_count, version = version + 1
      where id = v_room.id returning * into v_room;
      update public.rounds set latest_clue = p_text,
        clues = clues || jsonb_build_array(jsonb_build_object('text', p_text, 'at', now()))
      where id = v_round.id;
      insert into public.game_messages(room_id, round_number, word_index, sender_id, type, body, word_count)
      values(v_room.id, v_room.current_round, v_room.current_word_index, v_player.id, 'clue', p_text, p_word_count);

    elsif p_action in ('guess', 'skip') then
      if p_action = 'guess' and v_round.guesser_id <> v_player.id then
        raise exception 'GAME_403|Only the guesser can submit guesses';
      end if;
      if p_action = 'skip' and v_round.giver_id <> v_player.id then
        raise exception 'GAME_403|Only the clue giver can skip';
      end if;

      if p_action = 'guess' and (p_text is null or regexp_replace(lower(trim(p_text)), '[^a-z0-9]', '', 'g')
          <> regexp_replace(lower(v_answer), '[^a-z0-9]', '', 'g')) then
        insert into public.game_messages(room_id, round_number, word_index, sender_id, type, body)
        values(v_room.id, v_room.current_round, v_room.current_word_index, v_player.id, 'guess', p_text);
        insert into public.game_messages(room_id, round_number, word_index, type, body)
        values(v_room.id, v_room.current_round, v_room.current_word_index, 'wrong', 'Not quite');
        update public.rooms set version = version + 1 where id = v_room.id returning * into v_room;
        v_result := jsonb_build_object('outcome', 'wrong_guess', 'version', v_room.version, 'roomId', v_room.id);
        insert into public.processed_game_actions(id, room_id, player_id, result)
        values(p_action_id, v_room.id, v_player.id, v_result);
        return v_result;
      end if;

      v_statuses := v_round.statuses;
      v_statuses[v_room.current_word_index + 1] := case when p_action = 'guess' then 'guessed' else 'skipped' end;
      v_next_index := v_room.current_word_index + 1;
      if v_next_index < 8 then v_statuses[v_next_index + 1] := 'active'; end if;
      select count(*) into v_score from unnest(v_statuses) status where status = 'guessed';

      if p_action = 'guess' then
        insert into public.game_messages(room_id, round_number, word_index, sender_id, type, body)
        values(v_room.id, v_room.current_round, v_room.current_word_index, v_player.id, 'guess', p_text);
        insert into public.game_messages(room_id, round_number, word_index, type, body)
        values(v_room.id, v_room.current_round, v_room.current_word_index, 'correct', v_answer);
      else
        insert into public.game_messages(room_id, round_number, word_index, sender_id, type, body)
        values(v_room.id, v_room.current_round, v_room.current_word_index, v_player.id, 'skipped', v_answer);
      end if;

      update public.rounds set statuses = v_statuses, score = v_score, latest_clue = null,
        completed_at = case when v_next_index >= 8 then now() else completed_at end
      where id = v_round.id;

      if v_next_index >= 8 then
        if v_room.current_round = 1 then
          update public.players set round1_score = v_score, ready = false where id = v_round.guesser_id;
        else
          update public.players set round2_score = v_score, ready = false where id = v_round.guesser_id;
        end if;
        update public.rooms set status = 'round_result', current_word_index = 8, version = version + 1
        where id = v_room.id returning * into v_room;
      else
        update public.rooms set current_word_index = v_next_index, version = version + 1
        where id = v_room.id returning * into v_room;
      end if;
    else
      raise exception 'GAME_400|Unknown game action';
    end if;
  end if;

  v_result := jsonb_build_object('outcome', 'ok', 'version', v_room.version, 'roomId', v_room.id);
  insert into public.processed_game_actions(id, room_id, player_id, result)
  values(p_action_id, v_room.id, v_player.id, v_result);
  return v_result;
end;
$$;

revoke all on function public.mutate_game(text, uuid, text, uuid, text, text, boolean, integer, text[]) from public, anon, authenticated;
grant execute on function public.mutate_game(text, uuid, text, uuid, text, text, boolean, integer, text[]) to service_role;

commit;
