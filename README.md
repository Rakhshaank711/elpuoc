# 15 Words

A private, realtime guessing game for exactly two people. Built with Next.js App Router, TypeScript, Tailwind CSS, Supabase Postgres/Realtime, Zod, Vitest, and Playwright.

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

The normal browser suite uses mocked API state and runs in mobile Chromium and mobile WebKit. After applying migrations to a test Supabase project, run the complete two-browser lifecycle check with `LIVE_E2E=1 npm run test:e2e`.

## Deploy to Vercel

Import the repository into Vercel and add all four variables from `.env.example`. Set `NEXT_PUBLIC_SITE_URL` to the production origin. No custom server or additional build configuration is required.

Apply every database migration before deploying matching application code. Place the Vercel function region as close as possible to the Supabase project region; mismatched regions add latency to every authoritative action.
