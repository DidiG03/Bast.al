# Shtatat.al

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

Matches, live scores and pre-match odds come from [API-Football](https://www.api-football.com/) (api-sports.io). The API syncs fixtures and pre-match odds for today and the next six days. On a plan of 30,000 requests a day or more (Ultra: 75,000) today's are refreshed every 10 minutes, tomorrow's every 30, and later days every 2–4 hours; on a smaller plan (Pro: 7,500) every 30 minutes, 2 hours and 6–12 hours. While matches are on, in-play prices are fetched every 5 seconds while anyone is on the site (20 s otherwise), scores every 15 seconds and the match stats of matches with bets every 30. New live prices are pushed straight to the Players' pages, priced for their team, so nothing is fetched to show them. The plan's size and what's left come with each answer from API-Football: when what's left wouldn't last until the count resets (midnight UTC), the live updates slow down so it does, and `API_FOOTBALL_QUOTA_RESERVE` (8% of the plan) is always kept for live scores and results. If API-Football says the day's requests are used up, nothing is asked for 10 minutes, then one request checks. Every team starts from the feed price less Super Admin's base margin; an Owner can add or give back margin for their team and set their own price on any selection (Odds page). Managers and Players see their Owner's prices.

Super Admin picks which competitions are synced under **Odds → Leagues**: single leagues or every league in a country, from the list of competitions API-Football has a season running for. It takes effect on the next sync, with no restart; matches already listed from a league that's turned off stay until they're played. Until Super Admin saves a pick, `API_FOOTBALL_LEAGUES` and `API_FOOTBALL_COUNTRIES` (or the built-in list) apply, and **Reset to defaults** goes back to them.

| Variable | Purpose |
| --- | --- |
| `API_FOOTBALL_KEY` | API key from the API-Football dashboard. Without it the feed is off. |
| `API_FOOTBALL_LEAGUES` | Optional comma-separated league ids, used until Super Admin picks leagues on the Odds page. Defaults to about 60 competitions (list in `apps/api/src/odds/odds-sync.service.ts`): the top two divisions and main cups of England, Spain, Italy, Germany and France, the rest of Europe's top divisions, UEFA club competitions, national-team tournaments, qualifiers and friendlies, and the main leagues of the Americas, Asia and Australia. Unknown ids are logged at startup. |
| `API_FOOTBALL_COUNTRIES` | Optional comma-separated countries whose leagues are all synced. Defaults to `Albania,Kosovo`. |
| `API_FOOTBALL_BOOKMAKER` | Bookmaker whose prices we start from. Defaults to `8` (Bet365). |
| `ODDS_SYNC_DAYS`, `ODDS_SYNC_INTERVAL_MS`, `ODDS_LIVE_INTERVAL_MS`, `LIVE_ODDS_INTERVAL_MS` | Optional tuning: days ahead (7, at most 7), how often to check which days are due (10 min), live scores (15 s), live prices while anyone is on the site (5 s). |
| `API_FOOTBALL_QUOTA_RESERVE` | Requests kept each day for live scores and results; below it only today's matches are refreshed. Defaults to 8% of the plan, at least `600`. |
| `ODDS_FEED_MOCK=true` | Local testing only: serves made-up matches in API-Football's format when no key is set. |
| `LIVE_VERIFY`, `LIVE_GOAL_COOLDOWN_MS`, `LIVE_GOAL_MIN_PAUSE_MS`, `LIVE_SWING_COOLDOWN_MS`, `LIVE_REOPEN_COOLDOWN_MS`, `LIVE_SWING_POINTS`, `LIVE_CUTOFF_MINUTE` | Live-betting protection (see below). Defaults: check each live bet with the feed, pause the markets a goal, a red card, a VAR check or a penalty changes until the bookmaker has made their prices again after it with the new score (15 s at least, 90 s at most), 30 s after a result's chance jumps 12 points in the match-result prices, every market 15 s after the bookmaker reopens a match, and close from minute 89. |
| `LIVE_COMPETITION_MAX_LAG_MS`, `LIVE_COMPETITION_MIN_GOALS`, `LIVE_MARKET_STALE_MS`, `LIVE_ODDS_HOT_MS`, `LIVE_ODDS_HOT_MAX`, `API_FOOTBALL_MINUTE_RESERVE` | Keeping live markets open (see below). Defaults: a competition stays live unless its own goals reach the site later than 30 s at the 95th percentile (from 5 goals; a shorter delay only lengthens the wait; 0 turns the limit off), markets unpriced for 5 min during play taken off the live board, busy matches read on their own every 5 s, 4 at a time, keeping 20% of each minute's requests back. |
| `LIVE_BET_DELAY_MS`, `LIVE_BET_EVENTFUL_DELAY_MS`, `LIVE_BET_MAX_DELAY_MS`, `LIVE_BET_ADAPTIVE_DELAY`, `LIVE_LAG_PERCENTILE`, `LIVE_LAG_MARGIN_MS`, `LIVE_CHECK_TIMEOUT_MS`, `LIVE_SLOW_MATCH_MS` | How long a live bet waits: 8 s, 12 s on a busy match, or longer: at least the feed's delay on goals for the match's competition over the last 3 days (95% of goals within it, by each goal's least possible delay) plus 2 s, up to 30 s (`LIVE_BET_ADAPTIVE_DELAY=off` keeps it fixed). A competition whose delay is more than that takes no live bets, and nor does a match one of whose goals certainly reached the site more than 30 s late. The checks with the feed after the wait get 5 s. A live bet is only ever taken at the price the slip showed. The slip shows the real waits; the delays are logged per goal and per match, and Super Admin's `GET /odds/feed-delay` gives them by provider and competition. |
| `REALTIME_STREAM_MS` | How long each live-updates stream stays open before the browser reconnects (50 s): under the web host's 60 s function limit, so a stream ends cleanly instead of being cut. |
| `LATE_BUFFER_MS`, `LATE_ASSUMED_LAG_MS`, `LATE_MAX_FEED_LAG_MS`, `LATE_CHECK_WAIT_MS`, `LATE_RECHECK_SWEEP`, `LATE_SWEEP_DAYS` | The late-bet rule (`apps/api/src/bets/late.ts`): a live bet placed from 30 s before a goal's time on, on a score without it, is void if the goal helped it (the scoring side's win, Over, and so on; not the other side's win, Under, or a draw the goal broke; red cards and cards likewise; void when it can't be told). A goal's time is the start of its minute by the match clock the bet recorded, or else by the feed's kick-off times (then the earlier of that and 30 s before the site saw it); with no minute, 2 minutes before the site saw it. Bets voided under an older rule that the current one lets stand are put back and settled on the result. Checked when the site sees a goal, at settlement (which waits up to 3 hours for the timeline, then voids a bet on a later goal nothing can time rather than pay it), and every 10 minutes for settled live bets of the last 7 days that the rule in force never decided. `npm run late:recheck --workspace apps/api -- --player player_001` shows what it decides for one Player's live bets (`--apply` voids them). |

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

### Volleyball and handball

Games, results and prices come from [API-Sports' volleyball](https://api-sports.io/documentation/volleyball/v1) and [handball](https://api-sports.io/documentation/handball/v1) APIs (same account, each its own daily quota), each market from bet365 first and otherwise the first bookmaker that prices it. Bets close when a game starts (no live prices) and settle on the result; Super Admin can enter a result on the Settlement page (the sets won for volleyball; the 60-minute score and half-time score for handball).

- **Volleyball** (`src/odds/volleyball.ts`) settles on the sets won and every set's points: winner, set handicap, correct score in sets, total sets, a 4th or 5th set, each team to win a set, the 1st set and the match, points handicap and totals (match, each team, odd/even), and the 1st, 2nd and 3rd sets (winner, handicap, total points, each team's points, odd/even).
- **Handball** (`src/odds/handball.ts`) is on 60 minutes (extra time and penalties don't count) and is stored like a football match, with football's market keys, so football's grading settles it: result, double chance, draw no bet, Asian and European handicaps, total goals and each team's, odd/even, result and total goals, half time / full time, highest scoring half, and the same for each half.

Only half lines are offered on handicaps and totals. Same schedule as basketball: today's and tomorrow's games every 3 hours, each game's prices twice, results every 30 minutes while a started game has none. The default leagues are about 30 per sport, the top men's and women's leagues and the European cups and championships, which on a busy day is more games than the free plan's 100 requests can price; the rest are listed without prices until the quota allows. A paid API-Sports plan for each sport removes that limit.

| Variable | Purpose |
| --- | --- |
| `VOLLEYBALL_API_KEY`, `HANDBALL_API_KEY` | API-Sports keys. Default to `API_FOOTBALL_KEY` (when that's a direct API-Sports key). `VOLLEYBALL_FEED=off`, `HANDBALL_FEED=off` turn a sport off. |
| `VOLLEYBALL_LEAGUES`, `HANDBALL_LEAGUES` | API-Sports league ids, comma-separated. Default to the lists in `src/odds/team-sports-sync.service.ts`. |
| `VOLLEYBALL_SYNC_INTERVAL_MS`, `VOLLEYBALL_RESULTS_INTERVAL_MS`, `HANDBALL_SYNC_INTERVAL_MS`, `HANDBALL_RESULTS_INTERVAL_MS` | Defaults 3 hours and 30 minutes. |
| `VOLLEYBALL_BOOKMAKER`, `HANDBALL_BOOKMAKER` | The preferred bookmaker, 4 (bet365). |

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

**Live-betting protection** (`apps/api/src/odds/live-guard.ts`). Something happening in a live match pauses only the markets it changes:
- a goal (or one taken back) pauses the goal markets: result, double chance, totals, both teams to score, correct score, handicaps, odd/even and the rest that settle on goals;
- a red card, a VAR check or a penalty, or a jump in the match-result prices, pauses those and the cards markets;
- the bookmaker reopening a match it had blocked pauses every market for 15 s;
- a market the event doesn't change (cards after a goal, corners after a card) stays open only if the reading that brought the event still prices it; otherwise it waits for a reading made after the event.

A paused market reopens as soon as fresh prices for it arrive (the bookmaker's update time is later than the pause, or that market's own price has moved, with the latest score), never before 15 s (`LIVE_GOAL_MIN_PAUSE_MS`); without fresh prices it reopens at the fallback (90 s after a goal, card or VAR check, 30 s after a jump). A whole match stops taking bets only when the bookmaker blocks it (API-Football's block flag is match-wide; its per-market suspension pauses just that market), from the 89th minute, when no fresh prices have come in for 90 s, or when its competition's own feed is slower than the longest confirmation wait (`LIVE_COMPETITION_MAX_LAG_MS`, 30 s by default, from at least 5 goals: pre-match only, with a note). A shorter delay only makes the wait longer. A market the feed hasn't priced for `LIVE_MARKET_STALE_MS` (5 min) during play goes under "Not available during play", and cards or corners markets are left off live matches in a competition whose last 3+ live matches (30 days) never had a live price for them.

Live prices for the whole board come in one request every 5 s (20 s when nobody's on the site), slower when the day's requests wouldn't last. On top of that, the matches waiting for fresh prices to reopen markets and those with the most riding on them in open bets are read on their own (`LIVE_ODDS_HOT_MS`, 5 s; up to `LIVE_ODDS_HOT_MAX`, 4, at a time) whenever the board hasn't been read for them lately, keeping a fifth of each minute's requests back (`API_FOOTBALL_MINUTE_RESERVE`). Every 5 minutes the log sums up how often each live match was read and how far behind the bookmaker its prices were. Super Admin's Odds page shows **Live health** (`GET /odds/live-health?days=1`): the share of live market-time open per match and competition, how long pauses lasted and how many reopened on fresh prices, the share of live picks voided, the competitions with live limits, the feed plan and the polling per match.

Every live bet also waits 5 s. It is then checked with API-Football for that one match (bets on the same match at the same moment share one request). The bet is refused if the match is blocked, the score changed, the price moved, or the feed can't be reached. Players see which markets are paused and when they're back ("⚽ Goal · Paused: Match winner, Double chance and 15 more. Back within 71 s."), and, in place of a paused match result, another match to bet on meanwhile.

Request use: one extra request per live bet, on top of the live updates above.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run web and API in parallel |
| `npm run build` | Build both workspaces |
| `npm run lint` | Lint both workspaces |
| `npm run db:push` | Apply the Prisma schema to PostgreSQL |
| `npm test --workspace apps/api` | Build the API and run its unit tests |
| `docker compose up --build` | Run the complete local stack |
