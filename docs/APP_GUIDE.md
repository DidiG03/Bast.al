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

A pending transfer only goes through if Sam could still make it when Alex approves: Maria must still be Sam's Player, and Sam's account must still be active. Otherwise Alex rejects it.

This exists so a Manager can't accidentally (or on purpose) hand out huge amounts without the Owner noticing.

---

## What "payout cap" means (with a number)

Say a match is Man City vs Real Madrid, and Alex sets a payout cap of $5,000 on it — meaning "I never want to owe more than $5,000 if one specific result happens."

If Players have already bet enough that a Man City win would cost the team $4,800, and a new bet comes in that would push that number past $5,000, the app **refuses that new bet automatically**. It's a safety limit so one popular outcome can't bankrupt the team if it hits.

---

## What Players can bet on in football

The **Bet** page shows every match for the next 7 days from about 90 competitions: Europe's top leagues and their second divisions, England's League One and Two, the Balkans (Albania, Kosovo, North Macedonia, Montenegro, Bosnia, Slovenia, Bulgaria, and more), UEFA and national-team competitions, women's football (Champions League, WSL, Frauen-Bundesliga, Division 1), and the bigger leagues of the Americas, Africa and Asia. You can change the list on the **Odds** page.

A match opens to around 70 bet types under short headings:
- **Main:** result, double chance, draw no bet, both teams score.
- **Handicap:** Asian handicap (like "Tirana −1.5": Tirana have to win by 2 or more; half-goal lines only, so there's no draw) and the 3-way handicap (like "Tirana −1": a 2–1 win counts as a draw), on the match and on the 1st half.
- **Goals:** total goals lines, exact goals, goal ranges (0–1, 2–3, 4+), odd/even, correct score, winning margin.
- **Teams:** each team's goals and exact goals, each team to score, clean sheets, win to nil, first and last team to score, win from behind.
- **Halves:** half-time result and goals, each team's goals in each half, 2nd half double chance, half-time/full-time, each half's exact goals, scoring in both halves, a team to win both halves.
- **Combos:** result + total goals, total goals + both teams score, result + both teams score.
- **Goalscorers:** anytime, first and last goalscorer.
- **Corners & cards:** totals, most corners, corner ranges and the corners handicap.

Everything settles on the 90 minutes, never extra time. Goalscorer bets follow the usual rules: own goals don't count, a player who doesn't play gets the stake back, and so does a first-goalscorer pick on a player who came on after the first goal.

**Example:** Maria bets $10 on "Anytime goalscorer: Hulk" at 2.50. Hulk scores in the 27th minute, so she gets $25 back. Her friend's $10 on a player who stayed on the bench all match comes back as $10.

The feed spells players' names differently in different places ("Memphis Depay" and "M. Depay"). When the app can't tell for sure which player a bet means, it doesn't guess: the pick waits on the **Settlement** page, where you mark it Won, Lost or Void.

## Basketball (with a number)

The **Basketball** switch on the Bet page lists NBA games and the main European leagues (Euroleague, ABA, Italy, Spain, Turkey, Greece, France, Germany, Kosovo). Players bet on:
- **Winner:** either team, overtime included.
- **Handicap:** a team with points added or taken away, like "Olimpia Milano −8.5": Milano have to win by 9 or more.
- **Total points:** over or under a line, like 170.5, overtime included; each team's points; odd or even.
- **Result in regulation time:** home, draw or away after four quarters (overtime doesn't count), and double chance.
- **Half time / full time**, and **highest scoring half**.
- **Halves and quarters:** for the 1st half, the 2nd half (overtime included) and each quarter: who wins it (2-way, a tie gives the stake back; or 3-way), handicap, total points, each team's points and odd/even.

A European game has around 80 bets when the bookmaker prices them all; NBA games have the main three. Bets close at tip-off and settle on the final score, and the halves and quarters on the quarter scores the feed sends with it. Basketball picks can go in an accumulator with football and MMA.

**Example:** Maria bets $10 on "Verona +8.5" at 1.77. Milano win 87–80, but with the 8.5 points Verona finish ahead (88.5 to 87), so she gets $17.70 back.

For now the free plan shows games from the day before they're played. NBA prices need a free key from The Odds API; without it NBA games show without prices.

## NFL

The **NFL** switch on the Bet page lists NFL games, with the same bets as basketball (whichever the bookmaker prices, usually the main ones and the result in regulation time): **Winner**, **Handicap** (the spread, like "Detroit Lions −3.5": the Lions have to win by 4 or more) and **Total points**, all overtime included. If a game ends in a tie, Winner bets are void and the stake comes back.

Bets close at kick-off and settle on the final score. NFL picks can go in an accumulator with the other sports (not greyhounds). Like basketball, the free plan shows games from the day before they're played, so Sunday's games appear on Saturday.

## Tennis (with a number)

The **Tennis** switch on the Bet page lists ATP and WTA matches for today and tomorrow, with the tournament and round. Players bet on:
- **Match winner:** either player.
- **1st set winner:** either player.
- **Set betting:** the score in sets, like "Sinner 2-1" (in a best-of-five match, 3-0, 3-1 or 3-2).
- **To win in straight sets:** yes or no, for each player.
- **1st set correct score:** like "Sinner 6-4".
- **Total games:** over or under a line, like 21.5, in the match or in the 1st set. A tie-break counts as one game.
- **Games handicap:** a player with games added or taken away, like "Sinner −3.5": Sinner has to win at least 4 more games than the opponent.

Bets close at the listed start, or as soon as the match is on court if that's earlier, and settle when it ends. If a player retires, the 1st set bets stand once the 1st set was finished, and every other bet gets the stake back. A walkover gives every stake back. Tennis picks can go in an accumulator with the other sports (not greyhounds).

**Example:** Maria bets $10 on "1st set winner: Zverev" at 1.80 and $10 on "Match winner: Fritz" at 2.10. Zverev wins the 1st set 6-3, then retires injured. Her 1st set bet pays $18, and the Match winner bet comes back as $10.

On the Settlement page a tennis match has no score to enter: settle its picks one by one, or void the match.

## MMA (with a number)

On the **Bet** page there's also an **MMA** switch: UFC and other cards, each fight with both fighters, its weight class and bet365's prices less the team margin. Players can bet:
- **Fight winner:** either fighter. A draw gives the stake back.
- **Fight result:** either fighter, or a draw.
- **Total rounds:** over or under a line, like 1.5 rounds (over means the fight is still going at 2:30 of round 2).
- **Fight goes the distance**, when it's offered: yes if it ends with the judges.

Fight picks can go in an accumulator with football. Every fight on a card stops taking bets when the card's first fight starts, so nobody can bet on a fight after seeing how the night is going. A no contest gives every stake back.

**Example:** Maria bets $10 on Natalia Silva to beat Wang Cong at 1.40. Silva wins on the judges' scorecards after five rounds, so Maria gets $14 back. A friend's $5 on "Under 1.5 rounds" loses, because the fight went the full 25 minutes.

For now the MMA feed is on the free plan, so fights appear the day before they happen. A paid MMA plan would show the whole schedule.

## Greyhound racing (with a number)

On the **Bet** page, Players switch between **Football** and **Greyhounds**. Greyhounds lists the next races at British, Irish and Australian tracks, with each dog's trap colour and trainer.

There's no price before a greyhound race, so bets are paid the way British bookmakers take them:
- **Winner:** tap **SP** next to a dog. If it wins, the bet pays the dog's *starting price* (the price when the race starts), less the team's margin.
- **Forecast:** pick the 1st and 2nd dog in order. It pays the official *forecast dividend*, less the margin.
- **Tricast:** pick the 1st, 2nd and 3rd dog in order. It pays the official *tricast dividend*, less the margin. Offered on races of up to six dogs.

Race picks are single bets only, never in an accumulator. Bets close a minute before the start and settle about 15 minutes after the race, when the official result comes in.

The next three races also show on a Player's home page. **Latest results** on the Greyhounds tab lists the races of the last six hours with their finishing order. On the **Odds** page, the Greyhounds switch shows each race's dogs, or its result once run, and you can hide a race or suspend its bets like a match. A race with no official result six hours after its start has its bets refunded.

**Example:** Maria bets $10 on Swift Airy to win. Swift Airy wins at a starting price of 7/2 (4.50). With a 5% margin she's paid at 4.27, so she gets $42.70 back.

**The rules:**
- A dog withdrawn before the race: the stake comes back, and the same for a Forecast that names it.
- A race called off: everything comes back.
- Two dogs dead-heat for 1st: a Winner bet is paid on half its stake. A Forecast caught by a dead heat waits on the **Settlement** page for you.
- Nothing pays more than 50/1 on a Winner or 500 on a Forecast. Until a race is run, the team's payout cap counts each race bet at that most, so a big outsider can't catch an Owner out.

---

## What the Casino is (with a number)

The Casino tab opens on a lobby with four games: a fruit slot, Book of Ra, roulette and blackjack. The slot is a classic fruit game: 5 reels, 5 lines, fruit and sevens, and a star that pays anywhere. Cherries pay from 2 in a row. Players spin it with the same balance they bet with, at $0.50 to $10 a spin. It stays hidden until **you** open it for the site and the **Owner** opens it for their team. Its name is set in one place, `GAME_NAME` in `apps/api/src/casino/game.ts`.

Every spin is decided on the server, never on the Player's phone. On average it pays back **$95.70 for every $100** spun (measured over 10 million spins), so the team keeps about 4.3%. About 1 spin in 4 wins something.

After a win, a Player can try **double or nothing**: guess whether a card is red or black. Right doubles the win, wrong loses it. Up to 5 guesses in a row and up to $500. Each guess counts like a spin: in the ledger, in Commissions, and against the Player's max stake and daily loss limit. It's an even 50/50, so it doesn't change the payout rate.

**Example:** Maria spins 100 times at $1 and gets $93 back. Her balance is $7 lower, her **My money** page shows one line for the day ("Casino: 100 spins, −$7.00"), and the $7 counts in Alex's team profit, so you and Sam get your commission on it like on bets. Maria's daily loss limit counts sports and casino together.

**Roulette** is European roulette: 37 pockets, 0 to 36, with a single 0. Players put chips from $0.50 to $25 on the table, then spin. A single number pays 35 to 1, red or black 1 to 1, and everything in between pays the same way, so every bet pays back **$97.30 for every $100** on average (the team keeps about 2.7%). The number is drawn on the server too. All the chips on the table together can be up to the Player's max stake a spin, or $100 if they have none; the daily loss limit and the balance apply as for the slot. Roulette has its own line a day in **My money** ("Roulette: 12 spins") and counts in Commissions the same way. The Casino page shows staff each game's figures separately.

**Blackjack** is played with one hand against the dealer, from a fresh 6-deck shoe shuffled on the server for every round. The dealer stands on every 17 (soft 17 included), blackjack pays 3 to 2, and insurance (when the dealer shows an ace) costs half the bet and pays 2 to 1. A Player can split once and double down once a round. The first bet can be up to the Player's max stake ($100 if they have none); a double or a split adds to it and needs the balance. Money leaves the balance when it's put down and the win arrives when the round ends; a round left alone for an hour is stood and settled automatically. Played perfectly it pays back about **$99.60 for every $100** (measured over 3 million hands); real Players do a little worse, so the team keeps around 1–2%. It has its own line a day in **My money** ("Blackjack: 8 hands") and counts in Commissions like the other games.

**Book of Ra** follows the Deluxe rules: 5 reels, 10 lines, $0.50 to $10 a spin. The explorer, pharaoh, statue and scarab pay from 2 in a row, the cards (10 to A) from 3. The **book** stands in for any symbol on a line and pays anywhere: 3, 4 or 5 books pay 2, 20 or 200 times the bet and give **10 free spins**. Before they start, the book picks a **special symbol**. In each free spin, the special symbol on enough reels (2 for the explorer, pharaoh, statue and scarab, 3 for the cards) fills those reels and pays again on all 10 lines, even when the reels aren't next to each other. 3 books in a free spin give 10 more. A spin, or a whole round of free spins with the spin that started it, pays at most **5,000 times the bet** ($50,000 at the $10 bet). It pays back about **$94.90 for every $100** (measured over 60 million spins with their free spins); free spins start about once every 205 spins. Free spins play by themselves, one per spin on the server, and a round in progress is kept if the Player leaves. Players can also autoplay 10 to 100 spins; it stops for free spins, on a win they choose, or when the balance or a limit runs out. A Player in the middle of free spins can't be moved to another team until they're over. It has its own line a day in **My money** ("Book of Ra: 40 spins, 10 free spins").

**Example:** Maria spins at $1 and lands 3 books: $2, and 10 free spins. The book picks the explorer. In one free spin explorers land on reels 1, 3 and 5: they fill those reels and pay $10 on each of the 10 lines, $100.

Its pictures are drawn in code, except the explorer, which is a picture in that folder. To use your own, put the images in `apps/web/public/casino/book-of-ra/` and name each one in that folder's `manifest.json` (for example `"EXPLORER": "explorer.webp"`, and `"cover"` for the lobby tile). Any symbol left empty stays drawn.

---

## The pages, one line each

| Page | Who uses it | What it's for |
|---|---|---|
| **Overview** | Everyone | Your home screen — balance, quick stats, shortcuts. Looks totally different for Players (it's their "app"). |
| **Users** | Super Admin, Owner, Manager | Create people under you, give/take credit, suspend/delete, set limits. |
| **Bet** | Player | Browse matches, place bets, see your bet history. |
| **Casino** | Everyone (when it's open) | Players play the fruit slot, roulette and blackjack with their balance. Super Admin and Owners open or close it; staff see how it's doing per Player. |
| **Reports** | Super Admin, Owner, Manager | Who's under you, and a searchable history log of every action taken. |
| **Finance** | Super Admin, Owner | Approve/reject big money transfers; see how much moved where. |
| **Commissions** | Super Admin, Owner, Manager | Your paycheck — what you've earned from results, this week/month/custom range. |
| **Odds** | Super Admin, Owner | Set the profit margin baked into every price Players see. |
| **Risk** | Super Admin, Owner | "If this result happens, how much would we owe?" — worst case first. |
| **Settlement** | Super Admin | Manually fix a match result, settle a pick the feed couldn't (like an unclear goalscorer name), or refund a bet if the automatic system missed it. |
| **Security** | Everyone | Your own login history, devices, and password — nothing to do with the business. |

---

If any one of these is still fuzzy — especially Commissions, approval limits, or payout caps — tell me which one and I'll walk through it with a bigger example using real numbers from your own team.
