# Bast.al, explained simply

## The whole idea, in one story

Imagine four people: **You** (Super Admin), **Alex** (an Owner), **Sam** (a Manager who works for Alex), and **Maria** (a Player).

1. **You give Alex $10,000.** You didn't have $10,000 sitting anywhere — as Super Admin you can just create it and hand it to an Owner. Alex now has $10,000.

2. **Alex gives Sam $2,000 to manage Players with.** Alex now has $8,000 left. Sam now has $2,000. This $2,000 really did move — it came out of Alex's account.

3. **Sam gives Maria $500 to bet with.** Sam now has $1,500 left. Maria now has $500.

4. **Maria bets $50 and loses.** Only Maria's balance changes — she now has $450. Sam and Alex's balances don't move at all, win or lose. Betting only ever touches the Player's own $.

5. **At the end of the week, someone tallies up how much all of Sam's Players lost or won overall.** Say Sam's Players lost $300 total this week. That $300 is "team profit." Sam gets a cut of it as pay — say Sam's rate is 20%, so Sam earns $60. This $60 is **separate money**, not touched by anyone's balance — it's tracked on its own, like a paycheck.

6. Alex, who runs the team, owes **you** a cut too — say your rate on Alex is 10% of the team's profit. So you'd earn $30 from that same $300. Alex keeps the rest.

That's the whole business: **money flows down** ($10,000 → $2,000 → $500), **bets only touch the Player**, and **commission is a separate paycheck calculated afterward from results**, not something pulled out of anyone's balance.

Nobody automatically gets money back. If Alex wants their $8,000 back from Sam, Alex has to explicitly "reclaim" it — it doesn't happen on its own.

---

## What each person actually does in the app, day to day

### You (Super Admin)
- Create Owners, give them starting credit.
- Set each Owner's commission rate (your cut).
- Watch the whole platform's numbers.
- Step in only when something needs a manual fix (a match result the feed missed, a wrong entry).

**Example:** You go to **Users**, click **+**, create "Alex" as an Owner. You click into Alex's row → **Balance** → **Delegate credit** → type `10000` and a reason like "Starting float" → Send. Alex now has $10,000.

### Alex (Owner)
- Creates Managers and/or Players.
- Gives them credit to work with.
- Sets each Manager's commission rate (what Alex pays them).
- Checks the Commissions page to see what's owed to Managers and to you.

**Example:** Alex goes to **Users**, creates "Sam" as a Manager, then opens Sam's row → **Balance** → **Delegate credit** → `2000` → Send. Sam now has $2,000 to work with.

### Sam (Manager)
- Creates Players (or gets assigned some by Alex).
- Gives them credit to bet with.
- Never risks their own money — the $2,000 Alex gave Sam is just there to distribute to Players, not Sam's to keep.
- Earns a paycheck (commission) based on how much Sam's Players lose overall — that's Sam's actual income, not the $2,000.

**Example:** Sam creates "Maria" as a Player, gives her $500 the same way (Balance → Delegate credit → `500`).

### Maria (Player)
- Goes to **Bet**, picks matches, places bets with her own $500.
- Wins and losses only change her own balance.
- Checks **My Bets** to see open and settled bets.

---

## What "approval limit" means (with a number)

Say Alex sets a rule: "Any Manager sending more than $1,000 to a Player at once needs my okay first."

If Sam tries to give Maria $1,500, it doesn't go through instantly — it sits as **pending** until Alex approves it on the **Finance** page. If Sam gives Maria $500, it goes through immediately since it's under the limit.

This exists so a Manager can't accidentally (or on purpose) hand out huge amounts without the Owner noticing.

---

## What "payout cap" means (with a number)

Say a match is Man City vs Real Madrid, and Alex sets a payout cap of $5,000 on it — meaning "I never want to owe more than $5,000 if one specific result happens."

If Players have already bet enough that a Man City win would cost the team $4,800, and a new bet comes in that would push that number past $5,000, the app **refuses that new bet automatically**. It's a safety limit so one popular outcome can't bankrupt the team if it hits.

---

## What the Casino is (with a number)

The Casino tab has one slot game, **Golazo**: 5 reels, 10 lines, football symbols. Players spin it with the same balance they bet with, at $0.50 to $10 a spin. It stays hidden until **you** open it for the site and the **Owner** opens it for their team.

Every spin is decided on the server, never on the Player's phone. On average it pays back **$94.80 for every $100** spun (measured over 20 million spins), so the team keeps about 5%. Three goals anywhere give free spins.

**Example:** Maria spins 100 times at $1 and gets $93 back. Her balance is $7 lower, her **My money** page shows one line for the day ("Casino: 100 spins, −$7.00"), and the $7 counts in Alex's team profit, so you and Sam get your commission on it like on bets. Maria's daily loss limit counts sports and casino together.

---

## The pages, one line each

| Page | Who uses it | What it's for |
|---|---|---|
| **Overview** | Everyone | Your home screen — balance, quick stats, shortcuts. Looks totally different for Players (it's their "app"). |
| **Users** | Super Admin, Owner, Manager | Create people under you, give/take credit, suspend/delete, set limits. |
| **Bet** | Player | Browse matches, place bets, see your bet history. |
| **Casino** | Everyone (when it's open) | Players spin the Golazo slot with their balance. Super Admin and Owners open or close it; staff see how it's doing per Player. |
| **Reports** | Super Admin, Owner, Manager | Who's under you, and a searchable history log of every action taken. |
| **Finance** | Super Admin, Owner | Approve/reject big money transfers; see how much moved where. |
| **Commissions** | Super Admin, Owner, Manager | Your paycheck — what you've earned from results, this week/month/custom range. |
| **Odds** | Super Admin, Owner | Set the profit margin baked into every price Players see. |
| **Risk** | Super Admin, Owner | "If this result happens, how much would we owe?" — worst case first. |
| **Settlement** | Super Admin | Manually fix a match result or refund a bet if the automatic system missed it. |
| **Security** | Everyone | Your own login history, devices, and password — nothing to do with the business. |

---

If any one of these is still fuzzy — especially Commissions, approval limits, or payout caps — tell me which one and I'll walk through it with a bigger example using real numbers from your own team.
