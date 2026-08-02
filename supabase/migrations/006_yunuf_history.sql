begin;

create table if not exists public.yunuf_game_events (
  sequence bigint generated always as identity primary key,
  id uuid not null unique,
  room_id uuid not null references public.yunuf_rooms(id) on delete cascade,
  event jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists yunuf_game_events_room_sequence_idx
on public.yunuf_game_events(room_id, sequence);

alter table public.yunuf_game_events enable row level security;
revoke all on public.yunuf_game_events from anon, authenticated;

drop function if exists public.commit_yunuf_action(uuid, uuid, uuid, integer, text, jsonb);

create function public.commit_yunuf_action(
  p_room_id uuid,
  p_player_id uuid,
  p_action_id uuid,
  p_expected_version integer,
  p_status text,
  p_state jsonb,
  p_events jsonb
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

  insert into public.yunuf_game_events(id, room_id, event, created_at)
  select (item->>'id')::uuid, p_room_id, item,
    to_timestamp(((item->>'createdAt')::double precision) / 1000)
  from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as entries(item);

  v_result := jsonb_build_object('roomId', p_room_id, 'version', v_room.version + 1);
  insert into public.processed_yunuf_actions(id, room_id, player_id, result)
  values (p_action_id, p_room_id, p_player_id, v_result);
  return v_result;
end;
$$;

revoke all on function public.commit_yunuf_action(uuid, uuid, uuid, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_yunuf_action(uuid, uuid, uuid, integer, text, jsonb, jsonb) to service_role;

commit;
