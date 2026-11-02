// Run with `npm test --workspace apps/api` (builds first). The live match
// tracker (tracker/): matching our API-Football matches to SportScore's
// fixtures by names and kickoff, only when sure; the on/off switch; the embed
// address (only https on sportscore.com); and that the betting side never
// reads the tracker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { matchTrackerFixture, teamScore } = require("../dist/tracker/tracker-match.js");
const { trackerEmbedSrc, trackerEnabled } = require("../dist/tracker/tracker-embed.js");

const at = (iso) => new Date(iso);
const fixture = (externalId, homeTeam, awayTeam, kickoff) => ({ externalId, homeTeam, awayTeam, kickoff: at(kickoff) });

test("team names: spelling, accents and filler words don't matter; women's and youth sides do", () => {
  assert.equal(teamScore("Manchester United", "Manchester Utd"), 1);
  assert.equal(teamScore("FK Partizani", "Partizani"), 1);
  assert.equal(teamScore("Bayern München", "Bayern Munich"), 1);
  assert.equal(teamScore("Atlético Madrid", "Atletico Madrid"), 1);
  assert.ok(teamScore("Wolverhampton Wanderers", "Wolverhampton") >= 0.85);
  assert.equal(teamScore("Arsenal W", "Arsenal"), 0);
  assert.equal(teamScore("Arsenal W", "Arsenal Women"), 1);
  assert.equal(teamScore("Spain U21", "Spain"), 0);
  assert.ok(teamScore("Arsenal", "Chelsea") < 0.5);
  assert.ok(teamScore("Manchester City", "Manchester United") < 0.85);
});

test("matching: picks the fixture with both names and the kickoff, within 15 minutes", () => {
  const target = { homeTeam: "Manchester United", awayTeam: "Wolverhampton Wanderers", startsAt: at("2026-11-02T20:00:00Z") };
  const list = [
    fixture("a1", "Manchester City", "Wolves", "2026-11-02T20:00:00Z"),
    fixture("a2", "Manchester Utd", "Wolverhampton", "2026-11-02T20:05:00Z"),
    fixture("a3", "Arsenal", "Chelsea", "2026-11-02T20:00:00Z"),
  ];
  assert.deepEqual(matchTrackerFixture(target, list), { externalId: "a2", confidence: 0.9 });
});

test("matching: no answer when unsure", () => {
  const target = { homeTeam: "Arsenal", awayTeam: "Chelsea", startsAt: at("2026-11-02T20:00:00Z") };
  // Kickoff too far apart.
  assert.equal(matchTrackerFixture(target, [fixture("b1", "Arsenal", "Chelsea", "2026-11-02T20:30:00Z")]), null);
  // Home and away the other way round: a different reading of the match.
  assert.equal(matchTrackerFixture(target, [fixture("b2", "Chelsea", "Arsenal", "2026-11-02T20:00:00Z")]), null);
  // Two fixtures equally good (a duplicate in their list): don't guess.
  assert.equal(matchTrackerFixture(target, [fixture("b3", "Arsenal", "Chelsea", "2026-11-02T20:00:00Z"), fixture("b4", "Arsenal FC", "Chelsea FC", "2026-11-02T20:00:00Z")]), null);
  // The women's match at the same time isn't it.
  assert.equal(matchTrackerFixture(target, [fixture("b5", "Arsenal Women", "Chelsea Women", "2026-11-02T20:00:00Z")]), null);
  // No team names on our side.
  assert.equal(matchTrackerFixture({ homeTeam: null, awayTeam: null, startsAt: target.startsAt }, [fixture("b6", "Arsenal", "Chelsea", "2026-11-02T20:00:00Z")]), null);
  assert.equal(matchTrackerFixture(target, []), null);
});

test("switch: only LIVE_TRACKER_ENABLED=true turns it on", () => {
  assert.equal(trackerEnabled({}), false);
  assert.equal(trackerEnabled({ LIVE_TRACKER_ENABLED: "false" }), false);
  assert.equal(trackerEnabled({ LIVE_TRACKER_ENABLED: "1" }), false);
  assert.equal(trackerEnabled({ LIVE_TRACKER_ENABLED: "true" }), true);
  assert.equal(trackerEnabled({ LIVE_TRACKER_ENABLED: " TRUE " }), true);
});

test("embed address: filled from the configured template, only https on sportscore.com", () => {
  const env = (url) => ({ SPORTSCORE_EMBED_URL: url });
  assert.equal(trackerEmbedSrc("123", "sq", "dark", env("https://sportscore.com/widget/{id}?lang={lang}&theme={theme}")), "https://sportscore.com/widget/123?lang=sq&theme=dark");
  assert.equal(trackerEmbedSrc("123", "en", "light", env("https://widgets.sportscore.com/m/{id}")), "https://widgets.sportscore.com/m/123");
  assert.equal(trackerEmbedSrc("123", "en", "light", {}), null);
  assert.equal(trackerEmbedSrc("123", "en", "light", env("https://sportscore.com/widget")), null, "no {id} in the template");
  assert.equal(trackerEmbedSrc("123", "en", "light", env("http://sportscore.com/{id}")), null);
  assert.equal(trackerEmbedSrc("123", "en", "light", env("https://sportscore.com.evil.example/{id}")), null);
  assert.equal(trackerEmbedSrc("123", "en", "light", env("https://evilsportscore.com/{id}")), null);
  assert.equal(trackerEmbedSrc("1/../x", "en", "light", env("https://sportscore.com/{id}")), null);
});

test("display only: odds, bets and realtime code never import the tracker", () => {
  const dirs = ["odds", "bets", "realtime"].map((dir) => new URL(`../src/${dir}`, import.meta.url).pathname);
  const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]));
  for (const file of dirs.flatMap(files)) assert.doesNotMatch(readFileSync(file, "utf8"), /tracker\//, `${file} imports the tracker`);
});
