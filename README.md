# The Purple Helm league site

The website for The Purple Helm, a 12-team keeper fantasy football league on Sleeper. It is one web page, rebuilt on a schedule and published with GitHub Pages:

**https://thepurplehelm.com**

## What is on it

- **Home:** week-by-week playoff and Toilet Bowl chances, this week's biggest game, this week's matchups, last week's results.
- **Standings:** record and odds for every team, with magic numbers.
- **Playoff scenarios:** each team's most likely path, and a simulator where you pick the winners.
- **Trade Analyzer:** what a trade does to each team's chances this year and next.
- **Keepers:** every team's 2027 keeper options under the league's keeper rules, and who holds which 2027 picks.
- **Hall of Champions:** every finished season on Sleeper (champion, runner-up, third, top scorer, top record, last place, final standings), a record book and an all-time table.
- **Rules:** the league rules, copied from the league's rules doc.
- **How it works:** the method, in plain words.

A visitor can follow a team (saved on their device only, no team by default), which opens the other pages on that team. Playoff-scenario picks can be shared as a link (`#playoff-scenarios/p=...`); a link stops working once a new week's results are in.

The site has a dark and a light mode. It follows the device's setting until someone uses the switch in the header, and then remembers their pick on that device. Each banner in `assets/` has a `-light` twin.

## Where the numbers come from

Only public inputs: the Sleeper API (rosters, picks, drafts, scores, weekly projections), FantasyCalc's public player values (to estimate 2027 draft position), and `fair_history.json` (past league trades scored by one fixed rule). The odds come from simulations built on Sleeper's projections. They have not been checked against results yet, and the site says so.

## How it is built

| File | What it does |
|---|---|
| `build_data.py` | Pulls the inputs, fits the pick-value curve, works out keeper costs, runs the season simulations, writes `data.json`. Python 3 with numpy and scipy, plus curl. |
| `engine.js` | The math the page runs in the browser: best lineups, keeper plans, rule checks, trade verdicts, and the simulations behind the trade analyzer and the pick-the-winners tool. |
| `template.html` | The page: layout, styles and rendering. |
| `rules.html` | The league rules page. |
| `build_page.py` | Puts the data, engine and rules into the template and writes `index.html`. |
| `test_scen.js`, `test_engine.js`, `smoke*.js` | Checks. The `smoke` files need `npm install`. |
| `.github/workflows/site.yml` | Rebuilds and publishes: on every push, hourly, and every 20 minutes while games are on. |

To build it yourself:

```
python build_data.py     # about 20 seconds; writes data.json
python build_page.py     # writes index.html
node test_scen.js        # optional
```

`data.json` and `index.html` are build outputs and are not kept in the repo.

## Decisions on record

- **Trade verdict rule** (kept as is for now by Colton, Nov 10, 2026). A team's change is its title chance, plus a third of its playoff chance, less a third of its last-place chance, this year and next year added together. Under 1 point either way is no real change. "Works for both" needs both teams to gain with the smaller gain at least a third of the larger; otherwise the trade "favors" whoever is ahead; both losing is "bad for both"; neither moving is "too close to call". The constants are `W_PO`, `W_LAST`, `CALL_FLAT` and `CALL_SHARE` in `engine.js`. The one-third weights and the 1-point floor are judgment, not measured.

## Known gaps

- The build has not been run past Week 14 yet. Check it before the playoffs start.
- Week-by-week odds before November 10, 2026 are rebuilt from each week's records and rosters, not recorded at the time.
- The Hall of Champions starts in 2022, when the league moved to Sleeper. Earlier champions would have to be added by hand.
- The record book counts regular-season games only (Weeks 1-14). Playoff and Toilet Bowl games are used for the season results, not for records.
- The site's odds have not been scored against results. Since November 10, 2026 the build saves one snapshot of the published odds a day to the `odds-log` branch (`save_snapshot.py`), so that can be done after the season. One season of 12 teams will be thin evidence; the weekly game win chances give more to score.
- "What changed" on Home compares rebuilt week-by-week odds, not saved ones. Switch it to the odds log once that covers two weeks.
