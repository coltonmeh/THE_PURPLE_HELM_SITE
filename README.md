# The Purple Helm league site

The website for The Purple Helm, a 12-team keeper fantasy football league on Sleeper. It is one web page, rebuilt on a schedule and published with GitHub Pages:

**https://coltonmeh.github.io/THE_PURPLE_HELM_SITE/**

## What is on it

- **Home:** week-by-week playoff and Toilet Bowl chances, this week's biggest game, this week's matchups, last week's results.
- **Standings:** record and odds for every team, with magic numbers.
- **Playoff scenarios:** each team's most likely path, and a simulator where you pick the winners.
- **Trade Analyzer:** what a trade does to each team's chances this year and next.
- **Keepers:** every team's 2027 keeper options under the league's keeper rules, and who holds which 2027 picks.
- **Rules:** the league rules, copied from the league's rules doc.
- **How it works:** the method, in plain words.

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
- Saving each day's published odds, so they can be scored against results later, is not built yet.
