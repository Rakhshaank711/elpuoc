-- Existing deployments: rounds are now player-paced rather than time-limited.
alter table public.rooms drop column if exists round_ends_at;
alter table public.rounds drop column if exists ends_at;
