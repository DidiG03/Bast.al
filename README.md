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

When the API starts it brings the database up to the Prisma schema (`prisma db push`), so a deploy that adds a table or column needs no manual step. Changes that would lose data are refused and logged, and the API starts anyway; run `npm run db:push` by hand to review them. Set `DB_PUSH_ON_START=false` to turn this off.

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

Super Admin picks which competitions are synced under **Odds → Leagues**: single leagues or every league in a country, from the list of competitions API-Football has a season running for. It takes effect on the next sync, with no restart; matches already listed from a league that's turned off stay until they're played. Until Super Admin saves a pick, `API_FOOTBALL_LEAGUES` and `API_FOOTBALL_COUNTRIES` (or the built-in list) apply, and **Reset to defaults** goes back to them.

| Variable | Purpose |
| --- | --- |
| `API_FOOTBALL_KEY` | API key from the API-Football dashboard. Without it the feed is off. |
| `API_FOOTBALL_LEAGUES` | Optional comma-separated league ids, used until Super Admin picks leagues on the Odds page. Defaults to about 60 competitions (list in `apps/api/src/odds/odds-sync.service.ts`): the top two divisions and main cups of England, Spain, Italy, Germany and France, the rest of Europe's top divisions, UEFA club competitions, national-team tournaments, qualifiers and friendlies, and the main leagues of the Americas, Asia and Australia. Unknown ids are logged at startup. |
| `API_FOOTBALL_COUNTRIES` | Optional comma-separated countries whose leagues are all synced. Defaults to `Albania,Kosovo`. |
| `API_FOOTBALL_BOOKMAKER` | Bookmaker whose prices we start from. Defaults to `8` (Bet365). |
| `ODDS_SYNC_DAYS`, `ODDS_SYNC_INTERVAL_MS`, `ODDS_LIVE_INTERVAL_MS` | Optional tuning: days ahead (7, at most 7), how often to check which days are due (10 min), live interval (45 s). |
| `API_FOOTBALL_QUOTA_RESERVE` | Requests to keep in hand each day before only today's matches are refreshed. Defaults to `600`. |
| `ODDS_FEED_MOCK=true` | Local testing only: serves made-up matches in API-Football's format when no key is set. |
| `LIVE_VERIFY`, `LIVE_GOAL_COOLDOWN_MS`, `LIVE_SWING_COOLDOWN_MS`, `LIVE_REOPEN_COOLDOWN_MS`, `LIVE_SWING_POINTS`, `LIVE_CUTOFF_MINUTE`, `LIVE_FAST_INTERVAL_MS` | Live-betting protection (see below). Defaults: check each live bet with the feed, pause 90 s after a goal, 30 s after a result's chance jumps 12 points in the match-result prices, 15 s after the bookmaker reopens a match, close from minute 89, and fetch live prices every 15 s while someone is watching. |

The API needs outbound access to `v3.football.api-sports.io`.

### Basketball

Games and results come from [API-Sports' basketball API](https://api-sports.io/documentation/basketball/v1) (same account, its own daily quota). The default leagues (`BASKETBALL_LEAGUES`) are the NBA, Euroleague, ABA League and the top leagues of Italy, Spain, Turkey, Greece, France, Germany and Kosovo. Prices for the European leagues come from API-Sports (bet365 first); API-Sports has none for the NBA on any plan, so NBA prices come from [The Odds API](https://the-odds-api.com) (DraftKings first, then FanDuel, BetMGM), matched to API-Sports' games by team names and tip-off. Without `ODDS_API_KEY`, NBA games are listed without prices and can't be bet on.

Players bet at fixed prices on **Winner**, **Handicap** and **Total points**, all including overtime, plus everything else API-Sports prices for European games: each team's points, odd/even, the result in regulation time (3-way and double chance), half time / full time, highest scoring half, and for the 1st half, the 2nd half (overtime included) and each quarter the winner (2-way and 3-way), handicap, total points, each team's points and odd/even (up to 3 lines each). The period markets settle on the quarter scores, kept with the result in `Event.fightResult`; the half-time score is stored from them too. If Super Admin corrects a score so the quarters no longer add up, they're dropped and those picks wait on the Settlement page. European games offer the five half-point lines nearest the even one, so a bet never lands on the line; the NBA has the bookmaker's main line, and landing on a whole-number line gives the stake back. Bets close at tip-off. Bets settle on the final score, and Super Admin can correct a score on the Settlement page like a football one.

On the free plans: today's and tomorrow's games every 3 hours (2 requests), each European game's prices when it first appears and once more in its last 4 hours (never into the last 12 requests of the day), NBA prices every 6 hours (3 credits, about 360 a month), and results every 30 minutes only while a started game has none.

| Variable | Purpose |
| --- | --- |
| `ODDS_API_KEY` | The Odds API key, for NBA prices. |
| `NBA_ODDS_SPORTS` | The Odds API's lists to look in. Defaults to `basketball_nba,basketball_nba_preseason`: each list's games are checked for free, and prices (3 credits) are fetched only from a list with one of our coming games. |
| `BASKETBALL_API_KEY` | API-Sports key for basketball. Defaults to `API_FOOTBALL_KEY` (when that's a direct API-Sports key). `BASKETBALL_FEED=off` turns basketball off. |
| `BASKETBALL_LEAGUES` | API-Sports league ids, comma-separated. Defaults to the list above (`12,120,198,52,117,104,45,2,40,59`). |
| `BASKETBALL_SYNC_INTERVAL_MS`, `BASKETBALL_RESULTS_INTERVAL_MS`, `NBA_ODDS_INTERVAL_MS` | Defaults 3 hours, 30 minutes and 6 hours. |
| `BASKETBALL_DAYS`, `BASKETBALL_BOOKMAKER` | Days fetched from today (2, the free plan's limit) and the bookmaker for European prices (4, bet365). |

### NFL

Games, results and prices come from [API-Sports' American football API](https://api-sports.io/documentation/american-football/v1) (same account, its own daily quota), bet365 first. Bets are the same as basketball's: **Winner** (a tie is void), **Handicap** (the spread) and **Total points**, all including overtime, with the five half-point lines nearest the even one, and any of basketball's other markets the bookmaker prices (usually the result in regulation time). Bets close at kick-off and settle on the final score; Super Admin can correct a score on the Settlement page.

On the free plan (yesterday to tomorrow only, so a game is listed from the day before): today's and tomorrow's games every 3 hours (2 requests), each game's prices when it first appears and once more in its last 4 hours (never into the last 12 requests of the day), and results every 30 minutes only while a game that started over 2½ hours ago has none. A full Sunday stays near 70 requests.

| Variable | Purpose |
| --- | --- |
| `NFL_API_KEY` | API-Sports key for American football. Defaults to `API_FOOTBALL_KEY` (when that's a direct API-Sports key). `NFL_FEED=off` turns the NFL off. |
| `NFL_LEAGUES` | API-Sports league ids, comma-separated. Defaults to `1` (NFL); `2` is college football, which has many more games (each costs requests for its prices). |
| `NFL_SYNC_INTERVAL_MS`, `NFL_RESULTS_INTERVAL_MS`, `NFL_BOOKMAKER` | Defaults 3 hours, 30 minutes, and 4 (bet365). |

### MMA

Fights come from [API-Sports' MMA API](https://api-sports.io/documentation/mma/v1), the same account as API-Football with its own daily quota. Players bet at fixed prices (bet365's, less the team margin, like football) on **Fight winner** (a draw or no contest is void), **Fight result** (with the draw), **Total rounds over/under** ("Over 1.5" means past 2:30 of round 2) and, when priced, **Fight goes the distance**. Bets on every fight of a card close when the card's first fight starts. A no contest voids everything. Results settle once the feed has the method, round and time; if those haven't come six hours after the fight, the winner markets settle and the round bets wait on the Settlement page.

The free plan (100 requests a day) only sees yesterday to tomorrow, so fights appear the day before. The default schedule fits it: today's and tomorrow's fights and odds every 2 hours (4 requests), and results every 30 minutes only while a started fight has none (2 requests).

| Variable | Purpose |
| --- | --- |
| `MMA_API_KEY` | API-Sports key for MMA. Defaults to `API_FOOTBALL_KEY` (when that's a direct API-Sports key). `MMA_FEED=off` turns MMA off. |
| `MMA_SYNC_INTERVAL_MS`, `MMA_RESULTS_INTERVAL_MS` | Defaults 2 hours and 30 minutes. A paid MMA plan can run them faster. |
| `MMA_DAYS` | Days of fights fetched, from today. Defaults to `2` (the free plan's limit). |
| `MMA_BOOKMAKER` | Bookmaker whose prices we start from. Defaults to `5` (bet365 in the MMA list). |

### Tennis

Matches come from [API-Tennis](https://api-tennis.com): fixtures, set-by-set scores and bookmaker prices in one feed. Players bet on **Match winner**, **1st set winner**, **Set betting** (the score in sets, e.g. "Sinner 2-1"), **To win in straight sets**, **To win at least one set**, **To win from a set down**, **1st set / match**, **Sets handicap**, **Total games**, **Games handicap**, each player's games, games odd/even, and for the 1st and 2nd sets the winner, correct score, total games, games handicap, each player's games and odd/even, each when the feed prices it, at fixed prices less the team margin. Games count a tie-break, and a match tie-break, as one game. The feed's market names are logged once per start ("Tennis markets in the feed: …"), so one it names differently shows up. Bets close at the listed start, or as soon as the match is on court if that's earlier. If a player retires, the 1st set markets stand once the 1st set was finished and everything else is void; a walkover is void.

| Variable | Purpose |
| --- | --- |
| `TENNIS_API_KEY` | API key from API-Tennis. Without it tennis is off. `TENNIS_FEED=off` turns it off too. |
| `TENNIS_TOURS` | Competitions to list, by the feed's names, comma-separated. Defaults to `Atp Singles,Wta Singles`; add e.g. `Challenger Men Singles`. |
| `TENNIS_DAYS` | Days of matches fetched, from today. Defaults to `2` (up to 7). |
| `TENNIS_SYNC_INTERVAL_MS`, `TENNIS_LIVE_INTERVAL_MS` | Defaults 30 minutes (matches and prices, two requests) and 5 minutes (matches on court and results, only while a match is due or under way). |
| `TENNIS_BOOKMAKER` | Bookmaker whose prices we start from. Defaults to `bet365`, else the first that prices the whole market. |

### Greyhound racing

Races come from [GreyhoundAPI](https://greyhoundapi.com) (GB, Irish and Australian tracks; the Race Day plan, $49/month, is enough). There are no prices before a race, so race bets are paid the way UK bookmakers take them: **Winner** at the dog's starting price (SP), **Forecast** (1st and 2nd in order) at the official forecast dividend and **Tricast** (1st, 2nd and 3rd in order, on fields of up to six) at the official tricast dividend, all less the team's margin. Race picks are singles only. Bets close a minute before the scheduled start and settle when the final result arrives, usually 12–18 minutes after the race.

To protect the house, a Winner bet is paid at most `GREYHOUND_MAX_SP` (51.00, i.e. 50/1) a Forecast at most `GREYHOUND_MAX_FORECAST` (500.00) and a Tricast at most `GREYHOUND_MAX_TRICAST` (2000.00); the Owner's payout cap and the Risk page count open race bets at those ceilings. A withdrawn dog's bets (and Forecasts and Tricasts naming it) are void, a void or abandoned race refunds everything, and a dead heat for 1st pays a Winner bet on half its stake (a Forecast or Tricast touched by a dead heat waits on the Settlement page).

| Variable | Purpose |
| --- | --- |
| `GREYHOUND_API_KEY` | API key from GreyhoundAPI. Without it racing is off. A sandbox key (`gapi_test_…`, 50 requests a day) has cards and results but no SPs or dividends, so won bets wait. |
| `GREYHOUND_REGIONS` | Countries to list, comma-separated. Defaults to `GB,IE,AU`. |
| `GREYHOUND_HOURS` | How far ahead race cards are fetched. Defaults to `24` (up to 48). |
| `GREYHOUND_CARDS_INTERVAL_MS`, `GREYHOUND_RESULTS_INTERVAL_MS` | Defaults: race cards, today's results and the status of races awaiting one every 15 minutes (about 6 requests); new results every 2 minutes while a run race has open bets (1 request). Up to about 1,300 requests a day. A sandbox key uses 4 hours and 2 hours. |
| `GREYHOUND_MAX_SP`, `GREYHOUND_MAX_FORECAST`, `GREYHOUND_MAX_TRICAST` | The ceilings above. |
| `RACE_UNPLAYED_HOURS` | A race with no official result this long after its start has its bets refunded. Defaults to `6`. |

The API needs outbound access to `api.greyhoundapi.com`.

**Live-betting protection** (`apps/api/src/odds/live-guard.ts`). A live match stops taking bets when:
- the bookmaker has it blocked (dangerous attack, penalty, VAR);
- a goal went in, or was taken back, in the last 90 s;
- the match-result prices just jumped, which usually means a red card or a penalty;
- the bookmaker reopened it less than 15 s ago;
- it's the 89th minute or later;
- no fresh prices have come in for 90 s.

Every live bet also waits 5 s. It is then checked with API-Football for that one match (bets on the same match at the same moment share one request). The bet is refused if the match is blocked, the score changed, the price moved, or the feed can't be reached. Players see why a match is paused ("Goal! Live betting reopens in a moment").

Request use: one extra request per live bet. While someone has the live matches open, there is also one request every 15 s, which stops by itself when fewer than twice `API_FOOTBALL_QUOTA_RESERVE` requests are left for the day.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run web and API in parallel |
| `npm run build` | Build both workspaces |
| `npm run lint` | Lint both workspaces |
| `npm run db:push` | Apply the Prisma schema to PostgreSQL |
| `npm test --workspace apps/api` | Build the API and run its unit tests |
| `docker compose up --build` | Run the complete local stack |
