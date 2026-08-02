# 15 Words

A private, realtime guessing game for exactly two people. Built with Next.js App Router, TypeScript, Tailwind CSS, Supabase Postgres/Realtime, Zod, Vitest, and Playwright.

## Local setup

1. Create a Supabase project.
2. Run [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql) in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and add the project URL, anon key, and service-role key. Never expose the service-role key as a `NEXT_PUBLIC_` variable.
4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

The browser never reads or writes the game tables directly. All persistent mutations pass through `/api/game`, where player tokens, roles, clue budgets, answers, scores, indexes, and timer state are validated. Supabase Presence reports connection state, while Broadcast only tells the other device to refetch the authoritative snapshot. A five-second refetch is included as recovery for missed ephemeral events.

## Supabase Realtime

The app uses one public Realtime channel per private room ID: `room:{roomId}`. Presence contains only `playerId`, `name`, `role`, and `joinedAt`. No secret words, tokens, answers, or scores are broadcast.

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

## Deploy to Vercel

Import the repository into Vercel and add all four variables from `.env.example`. Set `NEXT_PUBLIC_SITE_URL` to the production origin. No custom server or additional build configuration is required.
