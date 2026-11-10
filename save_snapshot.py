"""Save today's published odds, once a day, so they can be scored against results later.

Usage: python save_snapshot.py <path to odds.jsonl>
One line per Central-time day: every team's odds and every remaining game's win chance, as published.
The log lives on its own branch (odds-log) so it never mixes with the site's code history.
"""
import datetime as dt
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

out = Path(sys.argv[1])
D = json.loads(Path("data.json").read_text())
day = dt.datetime.now(ZoneInfo("America/Chicago")).date().isoformat()
lines = [x for x in out.read_text().splitlines() if x.strip()] if out.exists() else []
if any(json.loads(x).get("day") == day for x in lines):
    print(f"odds for {day} are already saved")
    sys.exit(0)
ODDS = ("playoffs", "title", "runner", "third", "bottom4", "last", "top_scorer", "top_record", "exp_wins")
row = {
    "day": day, "asof": D["asof"], "season": D.get("season"), "last_done": D["last_done"], "week_live": D.get("week_live"), "sims": D.get("sims"),
    "teams": [{"rid": t["rid"], "user": t["user"], "w": t["w"], "l": t["l"], "t": t.get("t", 0), "pf": t["pf"], **{k: round(t[k], 4) for k in ODDS if k in t}} for t in D["teams"]],
    "games": [[g["w"], g["a"], g["b"], round(g["pa"], 4)] for g in D.get("games", [])],
}
out.parent.mkdir(parents=True, exist_ok=True)
with out.open("a") as f:
    f.write(json.dumps(row, separators=(",", ":")) + "\n")
print(f"saved odds for {day}: {len(row['teams'])} teams, {len(row['games'])} games")
