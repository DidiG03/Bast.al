# Bast.al

Modern hierarchical virtual-credit betting simulation workspace built with Next.js, NestJS, PostgreSQL, Redis, and BullMQ.

## Stack

- **Web:** Next.js 14, React, TypeScript, Clerk (`@clerk/nextjs`) for identity
- **API:** NestJS, Prisma, Clerk Backend SDK (JWT verify only), Pino, Sentry
- **Data:** PostgreSQL, Redis, BullMQ
- **Operations:** Docker Compose, Cloudflare-ready edge deployment, GitHub Actions

## Getting started

```bash
npm install
cp .env.example .env
# Fill Clerk keys from https://dashboard.clerk.com
# Make sure Docker Desktop (or another Docker daemon) is running.
docker compose up -d postgres redis
npm run db:push
npm run dev
```

The web app is available at `http://localhost:3000` and the API at `http://localhost:4000`.

If the API reports `Environment variable not found: DATABASE_URL`, the `.env` file has not been created yet. Copy `.env.example` to `.env` before starting the API.

The project database is exposed on host port `5433` so it can run alongside an existing PostgreSQL installation on `5432`. If `npm run db:push` reports `P1010` or a password error, make sure the Compose database is running and that `.env` uses port `5433`. The Compose defaults are user `postgres`, password `postgres`, and database `bastal`.

### Clerk Dashboard checklist

1. Create an application (Hobby/free is fine for identity).
2. **Disable public sign-ups** (Restrictions → Sign-up mode / Allowlist, or turn off "Enable sign-up").
3. Copy publishable + secret keys into `.env`.
4. Add a webhook endpoint `POST /api/webhooks/clerk` for `user.updated` and `user.deleted` (not relied on for create). Copy the signing secret to `CLERK_WEBHOOK_SECRET`.
5. MFA (TOTP) is a **Pro** feature. Keep `MFA_ENFORCEMENT_ENABLED=false` on Hobby.

### Bootstrap the first Super Admin

Public registration is off, so create the first user in the **Clerk Dashboard** (Users → Create), then link them once:

```bash
curl -X POST http://localhost:4000/api/users/bootstrap/super-admin \
  -H 'Content-Type: application/json' \
  -d '{"clerkId":"user_...","username":"superadmin","bootstrapSecret":"YOUR_BOOTSTRAP_SECRET"}'
```

After that, all further users are created in-app (see below). Rotate or clear `BOOTSTRAP_SECRET`.

## Authentication & authorization

### Identity (Clerk) vs authorization (our DB)

Clerk is used **only** for identity: sign-in, session cookies/JWTs, password reset, and (on Pro) TOTP. We do **not** use Clerk Organizations, Clerk roles, or Clerk permissions for the Owner → Manager → Player hierarchy.

Our Postgres `users` table is the source of truth:

| Column | Purpose |
| --- | --- |
| `clerk_id` | Links to Clerk user id (`user_…`) |
| `role` | `SUPER_ADMIN` \| `OWNER` \| `MANAGER` \| `PLAYER` |
| `parent_id` | Creator / hierarchy parent |
| `status` | `ACTIVE` \| `SUSPENDED` (never hard-deleted) |

### Request flow

1. Next.js middleware (`clerkMiddleware`) protects `/dashboard/*` and `/security/*`; unauthenticated users go to `/sign-in`. `/sign-up` redirects to `/sign-in`.
2. The web app calls the Nest API with `Authorization: Bearer <Clerk session JWT>`.
3. Nest `AuthGuard` verifies the JWT with `@clerk/backend` `verifyToken` (never trusts frontend claims), loads the local user by `clerk_id`, and attaches the **actor** to the request.
4. `RolesGuard` + permission helpers enforce who can create which role.
5. `HierarchyService.isInSubtree` (recursive SQL CTE) enforces subtree isolation on user/bet/wallet-style endpoints. Role alone is never enough for scoped resources.
6. Optional `MfaGuard` hard-blocks Super Admin / Owner when `MFA_ENFORCEMENT_ENABLED=true` and TOTP is not enrolled.

### Who can create whom

| Actor | May create |
| --- | --- |
| Super Admin | Owner |
| Owner | Manager, Player |
| Manager | Player |
| Player | — |

### What each role can do

| | Super Admin | Owner | Manager |
| --- | --- | --- | --- |
| Sees | Everyone | Themselves and their whole downline | Themselves and their Players |
| Credit | Prints credit into Owners; retires it on reclaim; signed adjustments on anyone | Delegates to / reclaims from direct Managers and Players | Delegates to / reclaims from their Players |
| Approvals (delegations over $10,000) | Approves anyone's; own delegations need none | Approves their downline's, never transfers into or out of their own account | — |
| Accounts | Suspend, reactivate, edit, delete anyone | Same, within their downline | Same, Players only |
| Moving Players | Anywhere | Between their own Managers, or directly under themselves | — |
| Limits | Balance limit, player capacity, commission for anyone | Same, for their direct reports | — |
| Reports | Platform report, full audit log, finance | Team report, team-scoped audit log, finance | Finance (own delegations) |

Suspending an account locks out everyone beneath it until it is reactivated. Player capacity is enforced both when a Player is created and when one is moved. An account can only be deleted once it has no children and its balance has been reclaimed.

Create flow (`POST /api/users`): Nest creates the Clerk user via Backend API **and** inserts the local row with `parent_id = actor.id`. Creators set **username** + initial password (share out-of-band). Email is never accepted from or returned to the UI — only username is shown.

### Webhooks

| Event | Behavior |
| --- | --- |
| `user.created` | **Ignored** — local rows are never auto-created from Clerk |
| `user.updated` | Syncs email only; never touches `role` / `parent_id` |
| `user.deleted` | Soft-suspends local user (`SUSPENDED`) for audit/ledger integrity |

Signatures are verified with Svix (`CLERK_WEBHOOK_SECRET`) before any mutation.

### Audit

Auth and authz failures, user create/suspend, identity sync, and bootstrap are written to `audit_logs` (`actor_id`, `action`, `target_id`, `ip_address`, `metadata`).

### Data protection (at rest / in transit)

This does **not** make the app “unhackable.” It reduces impact if the database is copied:

| Control | What it does |
| --- | --- |
| AES-256-GCM (`FIELD_ENCRYPTION_KEY`) | Encrypts email at rest (`email_cipher`); API never returns it |
| HMAC blind index (`email_hash`) | Lets us check uniqueness/sync without storing plaintext email |
| Request integrity HMAC (`REQUEST_INTEGRITY_SECRET`) | Anti-replay signatures on mutations via Next `/api/backend` proxy |
| IP threat intel + lockouts | Bans noisy IPs after auth/integrity failures (Redis if available) |
| Honeypot routes | `/api/admin`, `/.env`, etc. auto-ban scanners |
| Passwords | Never stored in our DB — Clerk only |
| Helmet + CSP / frame deny | Hardens HTTP responses (API + Next) |
| Rate limits | Throttles auth/user mutation endpoints |
| JWT verify on Nest | Authorization never trusts the frontend |
| Sanitized errors | No stack traces leaked in production |

Generate keys once and keep them secret:

```bash
openssl rand -hex 32   # FIELD_ENCRYPTION_KEY
openssl rand -hex 32   # REQUEST_INTEGRITY_SECRET
```

### Subtree helper tradeoff

We use a **recursive CTE** on `parent_id`. Hierarchy is shallow (three levels under Owner), so write path stays simple. A closure table would speed large-tree reads at the cost of maintaining edges on every create/move — revisit if fan-out grows.

## Odds feed

Matches, live scores and pre-match odds come from [API-Football](https://www.api-football.com/) (api-sports.io). The API syncs fixtures and pre-match odds for today and the next four days: today's every 30 minutes, tomorrow's every 2 hours, and later days every 6 hours. Live scores and in-play odds update every 45 seconds while matches are on. With the default league list this stays around 3,000–6,000 requests a day, inside the Pro plan's 7,500; if fewer than `API_FOOTBALL_QUOTA_RESERVE` (600) are left, only today's matches keep refreshing until the quota resets. Every team starts from the feed price less Super Admin's base margin; an Owner can add or give back margin for their team and set their own price on any selection (Odds page). Managers and Players see their Owner's prices.

| Variable | Purpose |
| --- | --- |
| `API_FOOTBALL_KEY` | API key from the API-Football dashboard. Without it the feed is off. |
| `API_FOOTBALL_LEAGUES` | Optional comma-separated league ids. Defaults to about 60 competitions (list in `apps/api/src/odds/odds-sync.service.ts`): the top two divisions and main cups of England, Spain, Italy, Germany and France, the rest of Europe's top divisions, UEFA club competitions, national-team tournaments, qualifiers and friendlies, and the main leagues of the Americas, Asia and Australia. Unknown ids are logged at startup. |
| `API_FOOTBALL_COUNTRIES` | Optional comma-separated countries whose leagues are all synced. Defaults to `Albania,Kosovo`. |
| `API_FOOTBALL_BOOKMAKER` | Bookmaker whose prices we start from. Defaults to `8` (Bet365). |
| `ODDS_SYNC_DAYS`, `ODDS_SYNC_INTERVAL_MS`, `ODDS_LIVE_INTERVAL_MS` | Optional tuning: days ahead (5, at most 7), how often to check which days are due (10 min), live interval (45 s). |
| `API_FOOTBALL_QUOTA_RESERVE` | Requests to keep in hand each day before only today's matches are refreshed. Defaults to `600`. |
| `ODDS_FEED_MOCK=true` | Local testing only: serves made-up matches in API-Football's format when no key is set. |

The API needs outbound access to `v3.football.api-sports.io`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run web and API in parallel |
| `npm run build` | Build both workspaces |
| `npm run lint` | Lint both workspaces |
| `npm run db:push` | Apply the Prisma schema to PostgreSQL |
| `npm test --workspace apps/api` | Build the API and run its unit tests |
| `docker compose up --build` | Run the complete local stack |
