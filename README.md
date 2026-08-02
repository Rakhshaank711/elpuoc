# Play Together

A collection of private realtime games, currently including 15 Words and Yunuf. Built with Next.js App Router, TypeScript, Tailwind CSS, Supabase Postgres/Realtime, Zod, Vitest, and Playwright.

## Local setup

1. Create a Supabase project.
2. Run every SQL file in [`supabase/migrations`](supabase/migrations) in numeric order in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and add the project URL, anon key, and service-role key. Never expose the service-role key as a `NEXT_PUBLIC_` variable.
4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

The browser never reads or writes the game tables directly. All persistent actions pass through `/api/game` and then through one room-locked Postgres transaction, where player tokens, roles, clue budgets, answers, scores, indexes, and idempotency keys are validated. Supabase Presence reports connection state. Broadcast carries only typing state and a state-invalidated hint; game state is always loaded through an authenticated Route Handler. A 30-second reconciliation and focus/reconnect refresh recover missed events.

## Yunuf

Yunuf supports 2–5 players and follows the custom rules in the product specification: mixed-suit circular sequences, exact two-card pairs, Show after three complete rounds, delayed final turns, joint winners, a 10-point failed-Show penalty, and elimination-score matches only.

Apply `005_yunuf.sql` and then `006_yunuf_history.sql` before opening Yunuf against a real Supabase project. Full room state, deck order, hands, and the append-only game-history audit are stored privately and are accessible only to the service-role Route Handler. Responses remove the deck order and every opponent hand until Show resolves. Mutations use action IDs plus expected versions and commit state plus audit events through one locked Postgres function. Normal gameplay mutations perform one parallel read stage and one atomic commit, then return the already-validated state without reloading the room. History is fetched separately only when a player opens it, so long matches do not make ordinary moves progressively heavier.

The in-game history button shows the persistent server-authored action record for rules disputes: discard order and top card, public discard draws, turn completion, Show, scoring, elimination, and timeouts. Face-down deck draws are logged without revealing the private card identity.

The browser polls while a match is open, so expired turns are auto-played authoritatively even if the active player disconnects. For fully unattended rooms, schedule an authenticated `GET /api/yunuf/cron` request once per minute using Vercel Cron, Supabase Cron, or another scheduler. Set `CRON_SECRET` and send it as `Authorization: Bearer <secret>`. Seats remain reserved for reconnection; stale rooms are removed after seven days.

Use `/games/yunuf/demo` for a database-free rules lab. It deliberately reveals all hands and supports injected test hands, manual round advancement, automated turns, Show, scoring, and new-hand setup.

## Supabase Realtime

The app uses one public Realtime channel per private room ID: `room:{roomId}`. Presence contains only `playerId`, `name`, `role`, and `joinedAt`. Broadcast never contains secret words, tokens, answers, scores, indexes, or messages.

For production, enable Realtime in the Supabase project. The SQL migration enables RLS and grants no browser policies on all public game tables; server-side service-role requests are the only database access path.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

The normal browser suite uses mocked API state and runs in mobile Chromium, mobile WebKit, and desktop Chromium. After applying migrations to a test Supabase project, run the complete 15 Words lifecycle with `LIVE_E2E=1 npm run test:e2e`, or a complete Yunuf elimination match with `LIVE_YUNUF_E2E=1 npm run test:e2e`.

## Deploy to Vercel

Import the repository into Vercel and add the variables from `.env.example`. Set `NEXT_PUBLIC_SITE_URL` to the production origin. `CRON_SECRET` is required only when configuring the unattended Yunuf timeout endpoint. No custom server or additional build configuration is required.

Apply every database migration before deploying matching application code. Place the Vercel function region as close as possible to the Supabase project region; mismatched regions add latency to every authoritative action.
