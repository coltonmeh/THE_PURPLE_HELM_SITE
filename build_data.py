"""Purple Helm league site: public data snapshot.

Public inputs only: the Sleeper API (league state, drafts, weekly projections) and FantasyCalc's
public market values (a stand-in for where a player would be drafted next year). No paid data.

Method (the same shape as Colton's private model, simplified):
  this season   a player is worth what he adds to the best starting lineup, week by week, from
                Sleeper's weekly projections re-scored with the league's scoring settings.
  next season   one curve, value-by-draft-pick, fitted on this league's 2026 draft:
                V(pick) = A * exp(-B * (pick - 1)), points per week over a waiver-wire replacement.
                Draft order is drawn at the Rumble, so every round is valued at the middle slot (6.5).
                KAPPA converts roster value into starting-lineup points (bench players don't start).
                pick value   = KAPPA * V(round)
                keeper value = KAPPA * (V(where he'd be drafted) - V(the round he costs))
Writes data.json next to this file.
"""
import datetime as dt
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from scipy.optimize import curve_fit

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
LEAGUE_ID = "1366536901804199936"
BASE = "https://api.sleeper.app/v1"
T = 12
ROUNDS = 15
POS_OK = ("QB", "RB", "WR", "TE", "DEF")
FLEX_POS = ("RB", "WR", "TE")
DEF_PA_SD = 9.0          # spread of points allowed around Sleeper's projected mean (DEF tier scoring)
WEEKLY_SD = 23.0         # week-to-week team scoring noise (league history, from Colton's model calibration)
HORIZON_SD = 7.0         # shared rest-of-season projection error per team (same source)
N_SIMS = 200000          # enough seasons that a 1-in-100 finish still has 2,000 examples to describe
SEED = 2026
# The league's fairness rule (registered Nov 4 2026): lineup points of a 2027 pick, middle of its round, over a 14-week
# season, keeper bonus included. The registered values are not always falling (a 5th above a 4th), so trades on this
# site use the never-rising version: neighbouring rounds that are out of order share their average.
CARD_PICK_REGISTERED = {1: 117.60, 2: 72.66, 3: 61.95, 4: 42.09, 5: 56.56, 6: 25.76, 7: 26.65, 8: 31.13, 9: 8.96,
                        10: 2.70, 11: 3.15, 12: 13.67, 13: 3.87, 14: -0.14, 15: 0.56}
CARD_TRIM = 0.80         # points-per-game pace runs hot: about 80% is delivered over the rest of a season
CARD_LAST_WEEK = 17
OFFLINE = bool(os.environ.get("PH_OFFLINE"))   # rebuild from the cached pull: same inputs, same snapshot time


def get(url, name, max_age_h=1.0):
    CACHE.mkdir(exist_ok=True)
    p = CACHE / f"{name}.json"
    if p.exists() and (OFFLINE or time.time() - p.stat().st_mtime < max_age_h * 3600):
        return json.loads(p.read_text())
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "--fail", "-m", "120", url], capture_output=True)
        if r.returncode == 0 and r.stdout:
            try:
                data = json.loads(r.stdout)
                p.write_text(json.dumps(data))
                return data
            except json.JSONDecodeError:
                pass
        time.sleep(2)
    if p.exists():
        return json.loads(p.read_text())
    raise RuntimeError(f"could not fetch {url}")


def never_rising(vals):
    """Pool adjacent violators so the sequence never rises; floor at zero."""
    blocks = []
    for v in vals:
        blocks.append([v, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] < blocks[-1][0] / blocks[-1][1]:
            v2, n2 = blocks.pop()
            blocks[-1][0] += v2
            blocks[-1][1] += n2
    out = []
    for tot, n in blocks:
        out += [max(tot / n, 0.0)] * n
    return out


# ------------------------------------------------------------------ scoring
def _phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


PA_TIERS = [("pts_allow_0", -1e9, 0.5), ("pts_allow_1_6", 0.5, 6.5), ("pts_allow_7_13", 6.5, 13.5),
            ("pts_allow_14_20", 13.5, 20.5), ("pts_allow_21_27", 20.5, 27.5),
            ("pts_allow_28_34", 27.5, 34.5), ("pts_allow_35p", 34.5, 1e9)]


def score_stats(stats, sc, is_def=False):
    pts = 0.0
    for k, v in stats.items():
        if k.startswith("pts_allow") or k.startswith("yds_allow"):
            continue
        w = sc.get(k)
        if w:
            pts += w * v
    if is_def and "pts_allow" in stats:
        mu = stats["pts_allow"]
        for key, lo, hi in PA_TIERS:
            w = sc.get(key, 0.0)
            if w:
                pts += w * (_phi((hi - mu) / DEF_PA_SD) - _phi((lo - mu) / DEF_PA_SD))
    return pts


# ------------------------------------------------------------------ lineup
def week_points(pids, w, proj, pos, slots, n_flex, fa, detail=False):
    """Best projected lineup for one week. Empty slots are filled from the waiver wire."""
    byp = {p: [] for p in slots}
    for pid in pids:
        p = pos.get(pid)
        if p not in byp:
            continue
        v = proj.get(pid, {}).get(w, 0.0)
        if v > 0:
            byp[p].append((v, pid))
    total, left, used, lineup = 0.0, [], {p: 0 for p in slots}, []
    for p, n in slots.items():
        vs = sorted(byp[p], reverse=True)
        take = vs[:n]
        total += sum(v for v, _ in take)
        lineup += [(p, pid, v) for v, pid in take]
        for _ in range(n - len(take)):
            v = fa[w][p][used[p]]
            used[p] += 1
            total += v
            lineup.append((p, "FA", v))
        if p in FLEX_POS:
            left += vs[n:]
    left.sort(reverse=True)
    flex = left[:n_flex]
    total += sum(v for v, _ in flex)
    lineup += [("FLEX", pid, v) for v, pid in flex]
    for _ in range(n_flex - len(flex)):
        v, p = max((fa[w][p][used[p]], p) for p in FLEX_POS)
        used[p] += 1
        total += v
        lineup.append(("FLEX", "FA", v))
    return (total, lineup) if detail else total


# ------------------------------------------------------------------ league history
def record_book(games, singles, seasons, log, pl):
    """The record book for one era: single-week marks, season marks and the longest runs. Regular-season games only."""
    if not games:
        return []
    for g in games:
        for k in ("a", "b"):
            if not g[k].get("team"): g[k] = {**g[k], "team": g[k]["user"], "user": ""}
    when = lambda g: f"{g['yr']}, Week {g['w']}"
    sides = [(g["pa"], g["a"], g["b"], g["pb"], g) for g in games] + [(g["pb"], g["b"], g["a"], g["pa"], g) for g in games]
    hi = max(sides, key=lambda x: x[0]); lo = min(sides, key=lambda x: x[0])
    close = min((g for g in games if g["pa"] != g["pb"]), key=lambda g: abs(g["pa"] - g["pb"]))
    blow = max(games, key=lambda g: abs(g["pa"] - g["pb"]))
    hi_loss = max((x for x in sides if x[0] < x[3]), key=lambda x: x[0]); lo_win = min((x for x in sides if x[0] > x[3]), key=lambda x: x[0])
    one = max(singles, key=lambda x: x[0]) if singles else None
    ord2 = lambda g: (g["a"], g["pa"], g["b"], g["pb"]) if g["pa"] >= g["pb"] else (g["b"], g["pb"], g["a"], g["pa"])
    vs = lambda me, opp, mine, theirs: f"{mine:.2f} to {theirs:.2f} against {opp['team']}"
    records = [
        {"label": "Highest score in a week", "value": f"{hi[0]:.2f}", "who": hi[1]["team"], "user": hi[1]["user"], "when": when(hi[4]), "detail": f"Beat {hi[2]['team']}, who scored {hi[3]:.2f}" if hi[0] > hi[3] else f"Lost to {hi[2]['team']}, who scored {hi[3]:.2f}"},
        {"label": "Lowest score in a week", "value": f"{lo[0]:.2f}", "who": lo[1]["team"], "user": lo[1]["user"], "when": when(lo[4]), "detail": f"Against {lo[2]['team']}, who scored {lo[3]:.2f}"},
    ]
    w_, wp, l_, lp = ord2(close)
    records.append({"label": "Closest game", "value": f"{wp - lp:.2f}", "who": w_["team"], "user": w_["user"], "when": when(close), "detail": f"Won {wp:.2f} to {lp:.2f} over {l_['team']}"})
    w_, wp, l_, lp = ord2(blow)
    records.append({"label": "Biggest blowout", "value": f"{wp - lp:.2f}", "who": w_["team"], "user": w_["user"], "when": when(blow), "detail": f"Won {wp:.2f} to {lp:.2f} over {l_['team']}"})
    records.append({"label": "Most points in a loss", "value": f"{hi_loss[0]:.2f}", "who": hi_loss[1]["team"], "user": hi_loss[1]["user"], "when": when(hi_loss[4]), "detail": f"{hi_loss[2]['team']} scored {hi_loss[3]:.2f}"})
    records.append({"label": "Fewest points in a win", "value": f"{lo_win[0]:.2f}", "who": lo_win[1]["team"], "user": lo_win[1]["user"], "when": when(lo_win[4]), "detail": f"{lo_win[2]['team']} scored {lo_win[3]:.2f}"})
    if one:
        v, pid, r, yr, w, who_ = one
        nm = (pl.get(pid, {}).get("full_name") or f"{pl.get(pid, {}).get('first_name', '')} {pl.get(pid, {}).get('last_name', '')}".strip() or pid)
        records.append({"label": "Most points by one starter", "value": f"{v:.2f}", "who": nm, "user": "", "when": f"{yr}, Week {w}", "detail": f"Started by {who_[r]['team']} ({who_[r]['user']})"})
    full = [(t, s_) for s_ in seasons for t in s_["table"]]
    if full:
        t, s_ = max(full, key=lambda x: x[0]["pf"]); records.append({"label": "Most points in a season", "value": f"{t['pf']:,.1f}", "who": t["team"] or t["user"], "user": t["user"] if t["team"] else "", "when": str(s_["season"]), "detail": f"Finished {t['rec']}"})
        t, s_ = min(full, key=lambda x: x[0]["pf"]); records.append({"label": "Fewest points in a season", "value": f"{t['pf']:,.1f}", "who": t["team"] or t["user"], "user": t["user"] if t["team"] else "", "when": str(s_["season"]), "detail": f"Finished {t['rec']}"})
        wins_of = lambda t: int(t["rec"].split("–")[0])
        t, s_ = max(full, key=lambda x: (wins_of(x[0]), x[0]["pf"])); records.append({"label": "Best record in a season", "value": t["rec"], "who": t["team"] or t["user"], "user": t["user"] if t["team"] else "", "when": str(s_["season"]), "detail": f"{t['pf']:,.1f} points"})
        t, s_ = min(full, key=lambda x: (wins_of(x[0]), x[0]["pf"])); records.append({"label": "Worst record in a season", "value": t["rec"], "who": t["team"] or t["user"], "user": t["user"] if t["team"] else "", "when": str(s_["season"]), "detail": f"{t['pf']:,.1f} points"})
    # longest runs of wins and of losses, carried across seasons
    def run(kind):
        best = (0, None, None)
        for u, rows in log.items():
            n, start = 0, None
            for row in rows:
                if row[2] == kind:
                    n, start = n + 1, (start if n else row)
                    if n > best[0]: best = (n, start, row)
                else:
                    n = 0
        return best
    for kind, label in (("W", "Longest winning streak"), ("L", "Longest losing streak")):
        n, a, b = run(kind)
        if n:
            span = f"{a[0]}, Weeks {a[1]}–{b[1]}" if a[0] == b[0] else f"{a[0]} Week {a[1]} to {b[0]} Week {b[1]}"
            records.append({"label": label, "value": f"{n} games", "who": b[3]["team"] or b[3]["user"], "user": b[3]["user"] if b[3]["team"] else "", "when": span, "detail": "Regular-season games"})
    return records


def espn_seasons(path="espn_history.json"):
    """The ESPN years (2010-2021) from the one-time import: season cards, games, each manager's results in order,
    and the all-time counts. Last place is left out: ESPN's records don't show how the league decided it then."""
    src = json.loads(Path(path).read_text())
    seasons, games, log, per = [], [], {}, {}
    for S in src["seasons"]:
        yr, reg = S["season"], S["reg_weeks"]
        T = {t["id"]: t for t in S["teams"]}
        who = {i: {"user": " & ".join(t["mgrs"]), "team": t["team"]} for i, t in T.items()}
        rec = lambda i: f"{T[i]['w']}–{T[i]['l']}" + (f"–{T[i]['t']}" if T[i]["t"] else "")
        tag = lambda i, extra=None: {"user": who[i]["user"], "team": who[i]["team"], "rec": rec(i), **(extra or {})}
        for mp, h, hp, a, ap, tier in S["games"]:
            if tier != "N" or a is None:
                continue
            games.append({"yr": yr, "w": mp, "a": who[h], "b": who[a], "pa": hp, "pb": ap})
            for i, mine, theirs in ((h, hp, ap), (a, ap, hp)):
                for m in T[i]["mgrs"]:
                    log.setdefault(m, []).append((yr, mp, "W" if mine > theirs else "L" if mine < theirs else "T", who[i]))
        last_w = max(g[0] for g in S["games"])
        fin = next(g for g in S["games"] if g[5] == "W" and g[0] == last_w)
        third = next((g for g in S["games"] if g[5] == "C" and g[0] == last_w), None)
        win = lambda g: (g[1], g[3]) if g[2] > g[4] else (g[3], g[1])
        cw, cl = win(fin)
        seed = sorted(T, key=lambda i: T[i]["seed"])
        top_pf = max(T, key=lambda i: T[i]["pf"])
        for i, t in T.items():
            for m in t["mgrs"]:                                       # a co-owned team counts for both of its managers
                o = per.setdefault(m, {"w": 0, "l": 0, "t": 0, "pf": 0.0, "g": 0, "seasons": 0, "titles": 0, "playoffs": 0, "lasts": 0})
                o["w"] += t["w"]; o["l"] += t["l"]; o["t"] += t["t"]; o["pf"] += t["pf"]; o["g"] += t["w"] + t["l"] + t["t"]; o["seasons"] += 1
                o["playoffs"] += t["seed"] <= S["playoff_teams"]; o["titles"] += i == cw
        seasons.append({"season": yr, "era": "espn", "champ": tag(cw), "runner": tag(cl), "third": tag(win(third)[0]) if third else None, "last": None,
                        "top_pf": tag(top_pf, {"pf": round(T[top_pf]["pf"], 1)}), "top_rec": tag(seed[0]),
                        "final": [max(fin[2], fin[4]), min(fin[2], fin[4])], "final_weeks": 1, "size": len(T),
                        "table": [{"user": who[i]["user"], "team": who[i]["team"], "rec": rec(i), "pf": round(T[i]["pf"], 1)} for i in seed]})
    return seasons, games, log, per


def hall_of_champions(lg, pl, last_done):
    """Champions, season awards and the record book, for every season the league has played on Sleeper.
    Records count regular-season games only (Weeks 1-14): lineups in the dead consolation weeks aren't real."""
    OLD = 24 * 365
    chain, cur_lg = [], lg
    while cur_lg:
        chain.append(cur_lg)
        prev = cur_lg.get("previous_league_id")
        cur_lg = get(f"{BASE}/league/{prev}", f"hist_league_{prev}", OLD) if prev and prev != "0" else None
    seasons, games, singles, per_owner = [], [], [], {}
    name_now, log = {}, {}                                            # log: every regular-season result per manager, in order
    for L in reversed(chain):                                         # oldest first
        yr, lid, done = int(L["season"]), L["league_id"], L["status"] == "complete"
        age = OLD if done else 0.2
        users = {u["user_id"]: u for u in get(f"{BASE}/league/{lid}/users", f"hist_users_{lid}", age)}
        ros = get(f"{BASE}/league/{lid}/rosters", f"hist_rosters_{lid}", age)
        who = {}
        for r in ros:
            u = users.get(r["owner_id"], {})
            who[r["roster_id"]] = {"uid": r["owner_id"], "user": u.get("display_name") or f"team {r['roster_id']}",
                                   "team": (u.get("metadata") or {}).get("team_name") or u.get("display_name") or f"team {r['roster_id']}"}
            name_now[r["owner_id"]] = who[r["roster_id"]]["user"]
        ps = int(L["settings"]["playoff_week_start"])
        reg_last = ps - 1 if done else min(last_done, ps - 1)
        W = {r: 0.0 for r in who}; Lo = {r: 0.0 for r in who}; T = {r: 0 for r in who}; PF = {r: 0.0 for r in who}
        pts = {}
        for w in range(1, (ps + 2 if done else reg_last) + 1):
            m = get(f"{BASE}/league/{lid}/matchups/{w}", f"hist_m_{lid}_{w}" if done else f"matchups_{w}", age if done else 0.2)
            pts[w] = {x["roster_id"]: float(x.get("points") or 0.0) for x in m}
            if w > reg_last:
                continue
            by = {}
            for x in m:
                by.setdefault(x["matchup_id"], []).append(x)
                for pid, v in zip(x.get("starters") or [], x.get("starters_points") or []):
                    if pid and pid != "0" and v:
                        singles.append((float(v), pid, x["roster_id"], yr, w, who))
            for k, v in by.items():
                if k is None or len(v) != 2:
                    continue
                a, b = v[0]["roster_id"], v[1]["roster_id"]; pa, pb = pts[w][a], pts[w][b]
                PF[a] += pa; PF[b] += pb
                if pa == pb:
                    T[a] += 1; T[b] += 1
                else:
                    wn, ls = (a, b) if pa > pb else (b, a)
                    W[wn] += 1; Lo[ls] += 1
                for r_, mine, theirs in ((a, pa, pb), (b, pb, pa)):
                    log.setdefault(who[r_]["uid"], []).append((yr, w, "W" if mine > theirs else "L" if mine < theirs else "T", who[r_]))
                games.append({"yr": yr, "w": w, "a": who[a], "b": who[b], "pa": pa, "pb": pb})
        rec = lambda r: f"{int(W[r])}–{int(Lo[r])}" + (f"–{T[r]}" if T[r] else "")
        seed = sorted(who, key=lambda r: -((W[r] + 0.5 * T[r]) * 1e5 + PF[r]))
        for r in who:
            o = per_owner.setdefault(who[r]["uid"], {"w": 0, "l": 0, "t": 0, "pf": 0.0, "g": 0, "seasons": 0, "titles": 0, "playoffs": 0, "lasts": 0})
            o["w"] += int(W[r]); o["l"] += int(Lo[r]); o["t"] += T[r]; o["pf"] += PF[r]; o["g"] += int(W[r] + Lo[r] + T[r]); o["seasons"] += 1
        if not done:
            continue
        tag = lambda r, extra=None: {"user": who[r]["user"], "team": who[r]["team"], "rec": rec(r), **(extra or {})}
        wb = get(f"{BASE}/league/{lid}/winners_bracket", f"hist_wb_{lid}", OLD)
        fin = next(x for x in wb if x.get("p") == 1); third = next((x for x in wb if x.get("p") == 3), None)
        # last place by the league's rule: seeds 9 v 12 and 10 v 11 in the first bracket week, the two losers
        # then play the next two weeks combined, and the loser of that finishes last
        lose = lambda a, b, ws: a if sum(pts[w].get(a, 0) for w in ws) < sum(pts[w].get(b, 0) for w in ws) else b
        l1, l2 = lose(seed[8], seed[11], [ps]), lose(seed[9], seed[10], [ps])
        last = lose(l1, l2, [ps + 1, ps + 2])
        lb = get(f"{BASE}/league/{lid}/losers_bracket", f"hist_lb_{lid}", OLD)
        lfin = next((x for x in lb if x.get("p") == 1), None)        # in Sleeper's loser bracket the game's loser advances, so "w" here lost
        if lfin and lfin.get("w") != last:
            print(f"hall: {yr} last place differs from Sleeper's bracket ({who[last]['user']} here, {who.get(lfin.get('w'), {}).get('user')} there)", file=sys.stderr)
        in_po = {x[k] for x in wb if x.get("r") == 1 for k in ("t1", "t2") if isinstance(x.get(k), int)}
        for r in in_po: per_owner[who[r]["uid"]]["playoffs"] += 1
        per_owner[who[fin["w"]]["uid"]]["titles"] += 1; per_owner[who[last]["uid"]]["lasts"] += 1
        top_pf = max(who, key=lambda r: PF[r])
        seasons.append({"season": yr, "champ": tag(fin["w"]), "runner": tag(fin["l"]), "third": tag(third["w"]) if third else None,
                        "last": tag(last), "top_pf": tag(top_pf, {"pf": round(PF[top_pf], 1)}), "top_rec": tag(seed[0]),
                        "final": [round(sum(pts[w].get(fin["w"], 0) for w in (ps + 1, ps + 2)), 2), round(sum(pts[w].get(fin["l"], 0) for w in (ps + 1, ps + 2)), 2)],
                        "table": [{"user": who[r]["user"], "team": who[r]["team"], "rec": rec(r), "pf": round(PF[r], 1)} for r in seed]})
    records = record_book(games, singles, seasons, log, pl)
    merged = {name_now[u]: dict(o) for u, o in per_owner.items()}
    e_seasons, e_records, first = [], [], int(chain[-1]["season"])
    try:                                                              # the ESPN years, when the import file is there
        e_seasons, e_games, e_log, e_per = espn_seasons()
        e_records = record_book(e_games, [], e_seasons, e_log, pl)
        for m, o in e_per.items():
            t = merged.setdefault(m, {k: (0.0 if k == "pf" else 0) for k in o})
            for k, v in o.items(): t[k] += v
        first = min(first, e_seasons[0]["season"])
    except Exception as err:
        print(f"hall: ESPN years skipped ({type(err).__name__}: {err})", file=sys.stderr); e_seasons, e_records = [], []
    alltime = [{"user": m, **{k: (round(v, 1) if k == "pf" else int(v)) for k, v in o.items()}} for m, o in merged.items()]
    alltime.sort(key=lambda o: -((o["w"] + 0.5 * o["t"]) / max(o["g"], 1)))
    return {"first": first, "first_sleeper": int(chain[-1]["season"]), "through": last_done, "season_now": int(lg["season"]),
            "seasons": seasons[::-1] + e_seasons[::-1], "records": records, "records_espn": e_records, "alltime": alltime}


# ------------------------------------------------------------------ keepers
def snake_pick(slot, rnd):
    return (rnd - 1) * T + (slot if rnd % 2 == 1 else T + 1 - slot)


def keeper_cost_2027(pid, holder, d26, kept25, kept26, by_trade):
    """(cost round or None, reason, keeper years left incl. 2027)."""
    p = d26.get(pid)
    if pid in kept26:
        if pid in kept25:
            return None, "Kept in 2025 and 2026 (two-year limit)", 0
        r = p["round"] - 1
        return (r, "Second and final keeper year", 1) if r >= 1 else (None, "Kept at a 1st in 2026", 0)
    if p is not None:
        r = p["round"]
        if r == 1:
            return None, "Drafted in round 1 (can't be kept)", 0
        if p["roster_id"] == holder or (pid, holder) in by_trade:
            if r == 2:
                return 1, "Drafted in round 2: costs a 1st, one year only", 1
            return r - 1, f"Drafted in round {r}", 2
        return r, f"Waiver pickup of a round-{r} pick (original round, one year)", 1
    return 10, "Free-agent add (a 10th, one year)", 1


def main():
    state = get(f"{BASE}/state/nfl", "state", 0.2)
    lg = get(f"{BASE}/league/{LEAGUE_ID}", "league", 0.5)
    sc = lg["scoring_settings"]
    rp = lg["roster_positions"]
    slots = {p: rp.count(p) for p in POS_OK}
    n_flex = rp.count("FLEX")
    bench = rp.count("BN")
    roster_max = sum(slots.values()) + n_flex + bench
    users = {u["user_id"]: u for u in get(f"{BASE}/league/{LEAGUE_ID}/users", "users")}
    ros = get(f"{BASE}/league/{LEAGUE_ID}/rosters", "rosters", 0.2)
    rids = sorted(r["roster_id"] for r in ros)
    last_done = int(lg["settings"].get("last_scored_leg") or 0)
    playoff_start = int(lg["settings"]["playoff_week_start"])
    deadline = int(lg["settings"].get("trade_deadline") or 0)
    nfl_week = int(state.get("leg") or state.get("week"))

    # ---- the week in progress (if any): which NFL teams have played
    cur = last_done + 1
    played_teams = set()
    if cur < 18:
        try:
            for x in get(f"https://api.sleeper.app/stats/nfl/2026/{cur}?season_type=regular", f"stats_{cur}", 0.2):
                p = x.get("player") or {}
                if p.get("position") == "DEF" and (x.get("stats") or {}).get("gp"):
                    played_teams.add(x["player_id"])
        except Exception:
            played_teams = set()
    week_started = bool(played_teams)
    first_trade_week = cur + 1 if week_started else cur      # a trade made now can't change a week already under way
    fut = list(range(first_trade_week, 18))

    # ---- projections, league scoring
    proj, meta = {}, {}
    for w in range(cur, 18):
        for x in get(f"https://api.sleeper.app/projections/nfl/2026/{w}?season_type=regular", f"proj_{w}", 3):
            p = x.get("player") or {}
            pos = p.get("position")
            if pos not in POS_OK:
                continue
            st = x.get("stats") or {}
            if not st or st.get("gp", 1) == 0:
                continue
            pts = score_stats(st, sc, pos == "DEF")
            if pts <= 0.05:
                continue
            pid = x["player_id"]
            proj.setdefault(pid, {})[w] = pts
            meta[pid] = {"name": f"{p.get('first_name', '')} {p.get('last_name', '')}".strip(), "pos": pos,
                         "team": p.get("team"), "inj": p.get("injury_status")}
    rosters = {r["roster_id"]: list(r["players"] or []) for r in ros}
    reserve = {r["roster_id"]: list(r.get("reserve") or []) for r in ros}
    rostered = {p for v in rosters.values() for p in v}
    pl = get(f"{BASE}/players/nfl", "players_nfl", 24)
    for pid in rostered:
        p = pl.get(pid, {})
        name = p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip() or pid
        if pid not in meta:
            if p.get("position") in POS_OK:
                meta[pid] = {"name": name, "pos": p.get("position"), "team": p.get("team"), "inj": p.get("injury_status")}
        else:
            meta[pid]["inj"] = p.get("injury_status")        # the players file is the fresher status
            meta[pid]["team"] = p.get("team") or meta[pid]["team"]
    pos = {pid: m["pos"] for pid, m in meta.items()}

    weeks_all = list(range(cur, 18))
    fa = {}
    for w in weeks_all:
        d = {p: [] for p in slots}
        for pid, pw in proj.items():
            if pid in rostered:
                continue
            v = pw.get(w, 0.0)
            if v > 0 and pos.get(pid) in d:
                d[pos[pid]].append(v)
        fa[w] = {p: sorted(d[p], reverse=True)[:6] + [0.0] * 6 for p in d}
        fa[w] = {p: v[:6] for p, v in fa[w].items()}

    ros_mean = {pid: float(np.mean([proj.get(pid, {}).get(w, 0.0) for w in fut])) for pid in meta}

    # ---- drafts and keeper history
    d26 = {p["player_id"]: p for p in get(f"{BASE}/draft/{lg['draft_id']}/picks", "draft26", 24 * 30)}
    prev = get(f"{BASE}/league/{lg['previous_league_id']}", "league_prev", 24 * 30)
    d25 = {p["player_id"]: p for p in get(f"{BASE}/draft/{prev['draft_id']}/picks", "draft25", 24 * 30)}
    kept25 = {pid for pid, p in d25.items() if p.get("is_keeper")}
    kept26 = {pid for pid, p in d26.items() if p.get("is_keeper")}
    by_trade, trades = set(), []
    for w in range(0, min(cur, 17) + 1):
        for t in get(f"{BASE}/league/{LEAGUE_ID}/transactions/{w}", f"tx_{w}", 0.5) or []:
            if t.get("status") != "complete" or t.get("type") != "trade":
                continue
            for pid, rid in (t.get("adds") or {}).items():
                by_trade.add((pid, rid))
            trades.append({"week": w, "adds": t.get("adds") or {}, "picks": t.get("draft_picks") or [],
                           "created": t.get("created")})

    # ---- 2027 picks after trades
    picks = {rid: {r: [rid] for r in range(1, ROUNDS + 1)} for rid in rids}
    for t in get(f"{BASE}/league/{LEAGUE_ID}/traded_picks", "traded", 0.5):
        if str(t["season"]) != "2027":
            continue
        rnd, orig, new = t["round"], t["roster_id"], t["owner_id"]
        for rid in rids:
            if orig in picks[rid].get(rnd, []):
                picks[rid][rnd].remove(orig)
        picks[new].setdefault(rnd, []).append(orig)

    # ---- value curve, fitted on this league's 2026 draft (non-keeper picks)
    repl = {}
    for p_ in POS_OK:
        v = sorted([ros_mean[x] for x in meta if pos[x] == p_ and x not in rostered], reverse=True)
        repl[p_] = float(np.mean(v[:3])) if v else 0.0
    xs, ys = [], []
    for pid, p in d26.items():
        if p.get("is_keeper"):
            continue
        ps = pos.get(pid) or (p.get("metadata") or {}).get("position")
        if ps not in POS_OK:
            continue
        xs.append(p["pick_no"])
        ys.append(max(0.0, ros_mean.get(pid, 0.0) - repl.get(ps, 0.0)))
    f = lambda n, a, b: a * np.exp(-b * (n - 1))
    (A, B), _ = curve_fit(f, np.array(xs, float), np.array(ys), p0=(10, 0.02))
    A, B = float(A), float(B)
    V = lambda n: A * math.exp(-B * (n - 1))

    # KAPPA: starting-lineup points per unit of roster value, on the rosters each team drafted
    drafted = {r: [] for r in rids}
    for pid, p in d26.items():
        drafted[p["roster_id"]].append(pid)
    kx, ky = [], []
    for r, pids in drafted.items():
        ky.append(np.mean([week_points(pids, w, proj, pos, slots, n_flex, fa) for w in fut]))
        kx.append(sum(max(0.0, ros_mean.get(p, 0.0) - repl.get(pos.get(p), 0.0)) for p in pids))
    KAPPA = float(np.polyfit(kx, ky, 1)[0])
    kappa_corr = float(np.corrcoef(kx, ky)[0, 1])
    round_val = {r: KAPPA * V(snake_pick(6.5, r)) for r in range(1, ROUNDS + 1)}

    # ---- where each player would be drafted next year: FantasyCalc market rank (half dynasty, half redraft)
    fc_d = get("https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1", "fc_dyn", 12)
    fc_r = get("https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1", "fc_red", 12)
    dyn = {x["player"]["sleeperId"]: x["value"] for x in fc_d if x["player"].get("sleeperId")}
    red = {x["player"]["sleeperId"]: x["value"] for x in fc_r if x["player"].get("sleeperId")}
    val = {pid: 0.5 * dyn.get(pid, 0) + 0.5 * red.get(pid, 0) for pid in set(dyn) | set(red)}
    rank = {p: i + 1 for i, p in enumerate(sorted(val, key=lambda p: (-val[p], p)))}

    # ---- keeper rows for every rostered player
    keep = {}
    for rid in rids:
        for pid in rosters[rid]:
            if pid not in meta:
                continue
            cost, why, yrs = keeper_cost_2027(pid, rid, d26, kept25, kept26, by_trade)
            zero_ros = max((proj.get(pid, {}).get(w, 0.0) for w in fut), default=0.0) == 0.0
            rule7 = bool(zero_ros and meta[pid].get("inj") in ("IR", "Out", "PUP", "Sus", "NA") and cost is not None)
            keep[pid] = {"cost": cost, "why": why, "yrs": yrs, "rank": rank.get(pid), "rule7": rule7}

    # ---- the fairness rule's inputs: points per game so far, from the league's own weekly scores
    tot_pts, games = {}, {}
    for w in range(1, first_trade_week):
        for m in get(f"{BASE}/league/{LEAGUE_ID}/matchups/{w}", f"matchups_{w}", 0.2 if w >= cur else 24 * 30):
            for pid, v in (m.get("players_points") or {}).items():
                if v:
                    tot_pts[pid] = tot_pts.get(pid, 0.0) + v
                    games[pid] = games.get(pid, 0) + 1
    ppg = {pid: tot_pts[pid] / games[pid] for pid in tot_pts}
    card_pos = {pid: ("DEF" if pid.isalpha() else ((pl.get(pid, {}).get("fantasy_positions") or [pl.get(pid, {}).get("position")])[0])) for pid in rostered}
    hist = json.loads((HERE / "fair_history.json").read_text())
    smooth = never_rising([CARD_PICK_REGISTERED[r] for r in range(1, ROUNDS + 1)])
    card = {"trim": CARD_TRIM, "first_week": first_trade_week, "weeks": CARD_LAST_WEEK - first_trade_week + 1,
            "band": hist["band"], "median": hist["median"], "n": hist["n"], "trades": hist["trades"],
            "not_scored": hist["not_scored"], "cutoff": "2026-11-04T00:00:00Z",
            "pick_pts": {str(r): round(smooth[r - 1], 2) for r in range(1, ROUNDS + 1)},
            "pick_pts_registered": {str(r): v for r, v in CARD_PICK_REGISTERED.items()}}

    # ---- standings and a simple season simulation (Sleeper projections only)
    name = {}
    for r in ros:
        u = users.get(r["owner_id"], {})
        name[r["roster_id"]] = {"user": u.get("display_name", f"team{r['roster_id']}"),
                                "team": (u.get("metadata") or {}).get("team_name") or u.get("display_name")}
    wins = {r["roster_id"]: r["settings"]["wins"] for r in ros}
    losses = {r["roster_id"]: r["settings"]["losses"] for r in ros}
    ties = {r["roster_id"]: r["settings"].get("ties", 0) for r in ros}
    pf = {r["roster_id"]: r["settings"]["fpts"] + r["settings"].get("fpts_decimal", 0) / 100 for r in ros}
    pa = {r["roster_id"]: r["settings"].get("fpts_against", 0) + r["settings"].get("fpts_against_decimal", 0) / 100 for r in ros}
    faab = {r["roster_id"]: lg["settings"].get("waiver_budget", 100) - r["settings"].get("waiver_budget_used", 0) for r in ros}
    ix = {r: i for i, r in enumerate(rids)}
    sched, live_pts, live_rem_mu, live_share = {}, {}, {}, {}
    for w in range(cur, playoff_start):
        m = get(f"{BASE}/league/{LEAGUE_ID}/matchups/{w}", f"matchups_{w}", 0.2)
        by = {}
        for x in m:
            by.setdefault(x["matchup_id"], []).append(x["roster_id"])
            if w == cur and week_started:
                rem = 0.0
                for pid in x.get("starters") or []:
                    team = pid if pid.isalpha() else (pl.get(pid, {}).get("team"))
                    if team and team not in played_teams:
                        rem += proj.get(pid, {}).get(w, 0.0)
                full = max(week_points(rosters[x["roster_id"]], w, proj, pos, slots, n_flex, fa), 1.0)
                live_pts[x["roster_id"]] = float(x.get("points") or 0.0)
                live_rem_mu[x["roster_id"]] = rem
                live_share[x["roster_id"]] = min(rem / full, 1.0)
        sched[w] = [tuple(v) for k, v in sorted(by.items(), key=lambda kv: kv[0] or 99) if k is not None and len(v) == 2]
    mu = {w: np.array([week_points(rosters[r], w, proj, pos, slots, n_flex, fa) for r in rids]) for w in range(cur, 18)}

    rng = np.random.default_rng(SEED)
    N = N_SIMS
    W = np.tile(np.array([wins[r] + 0.5 * ties[r] for r in rids], float), (N, 1))
    PF = np.tile(np.array([pf[r] for r in rids], float), (N, 1))
    horizon = rng.normal(0, HORIZON_SD, (N, T))
    score = {}
    for w in range(cur, 18):
        if w == cur and week_started:
            sh = np.array([live_share.get(r, 0.0) for r in rids])
            base = np.array([live_pts.get(r, 0.0) + live_rem_mu.get(r, 0.0) for r in rids])
            score[w] = base + rng.normal(0, 1, (N, T)) * WEEKLY_SD * np.sqrt(sh) + horizon * sh
        else:
            score[w] = mu[w] + rng.normal(0, WEEKLY_SD, (N, T)) + horizon
    for w in range(cur, playoff_start):
        s = score[w]
        for a, b in sched[w]:
            ia, ib = ix[a], ix[b]
            W[:, ia] += s[:, ia] > s[:, ib]
            W[:, ib] += s[:, ib] > s[:, ia]
        PF += s
    order = np.argsort(-(W * 1e5 + PF), axis=1)                     # record, then points for
    rows = np.arange(N)

    def game(x, y, s):
        return np.where(s[rows, x] >= s[rows, y], x, y), np.where(s[rows, x] >= s[rows, y], y, x)

    s15 = score[playoff_start]
    s1617 = score[playoff_start + 1] + score[playoff_start + 2]
    w1, l1 = game(order[:, 0], order[:, 3], s15)
    w2, l2 = game(order[:, 1], order[:, 2], s15)
    champ, runner = game(w1, w2, s1617)
    third, _ = game(l1, l2, s1617)
    _, lo1 = game(order[:, 8], order[:, 11], s15)
    _, lo2 = game(order[:, 9], order[:, 10], s15)
    _, last = game(lo1, lo2, s1617)
    top_sc = np.argmax(PF, axis=1)

    # which remaining games move the races: each team's odds with a win and with a loss, from the same simulations
    in_po = np.zeros((N, T), bool)
    in_b4 = np.zeros((N, T), bool)
    for k in range(4):
        in_po[rows, order[:, k]] = True
        in_b4[rows, order[:, 8 + k]] = True
    cond = lambda mask, col: round(float(col[mask].mean()), 4) if mask.sum() >= 400 else None
    games_out = []
    for w in range(first_trade_week, playoff_start):
        s = score[w]
        for a, b in sched[w]:
            ia, ib = ix[a], ix[b]
            wa = s[:, ia] > s[:, ib]
            games_out.append({"w": w, "a": a, "b": b, "pa": round(float(wa.mean()), 4),
                          "a_po": [cond(wa, in_po[:, ia]), cond(~wa, in_po[:, ia])], "b_po": [cond(~wa, in_po[:, ib]), cond(wa, in_po[:, ib])],
                          "a_b4": [cond(wa, in_b4[:, ia]), cond(~wa, in_b4[:, ia])], "b_b4": [cond(~wa, in_b4[:, ib]), cond(wa, in_b4[:, ib])]})
    # ---- playoff scenarios: every team's chances by how it finishes, and the commonest way each race turns out
    left = playoff_start - cur                                       # regular-season games each team still has
    W0 = np.array([wins[r] + 0.5 * ties[r] for r in rids], float)
    remw = np.rint(W - W0).astype(int)                               # wins added the rest of the way
    p_po, p_b4 = in_po.mean(axis=0), in_b4.mean(axis=0)
    proj_po = [int(i) for i in np.argsort(-p_po)[:4]]                # the four teams most likely to make each field today
    proj_b4 = [int(i) for i in np.argsort(-p_b4)[:4]]
    MIN_PATH, MIN_CELL = 400, 300                                    # fewest simulated seasons a statement may rest on

    def mode_wins(mask, i):
        c = np.bincount(remw[mask, i], minlength=left + 1)
        return int(c.argmax()), float(c.max() / max(int(mask.sum()), 1))

    def path(i, E, inset, proj, entering):
        """The commonest way event E happens to team i: its record the rest of the way and, when E means trading places
        with a team in (or out of) today's projected field, the team it most often trades places with."""
        n = int(E.sum())
        if n < MIN_PATH:
            return None
        k, share = mode_wins(E, i)
        out = {"k": k, "share": round(share, 4), "n": n}
        flips = (i not in proj) if entering else (i in proj)         # does E change today's projected field?
        if flips:
            cand = [j for j in (proj if entering else [x for x in range(T) if x not in proj]) if j != i]
            # entering the field pushes a projected member out; leaving it lets an outsider in
            masks = {j: E & (~inset[:, j] if entering else inset[:, j]) for j in cand}
            j = max(cand, key=lambda j: int(masks[j].sum()))
            m = masks[j]
            if int(m.sum()) >= MIN_PATH // 4:
                pk, _ = mode_wins(m, j)
                out["with"] = {"rid": rids[j], "share": round(float(m.sum() / n), 4), "k": pk}
        return out

    scen_teams = {}
    for r in rids:
        i = ix[r]
        rows = []
        for k in range(left + 1):
            m = remw[:, i] == k
            c = int(m.sum())
            rows.append([k, round(c / N, 4),
                         round(float(in_po[m, i].mean()), 4) if c >= MIN_CELL else None,
                         round(float(in_b4[m, i].mean()), 4) if c >= MIN_CELL else None])
        scen_teams[str(r)] = {
            "rec": rows,
            "po": {"proj": i in proj_po, "in": path(i, in_po[:, i], in_po, proj_po, True), "out": path(i, ~in_po[:, i], in_po, proj_po, False)},
            "b4": {"proj": i in proj_b4, "in": path(i, in_b4[:, i], in_b4, proj_b4, True), "out": path(i, ~in_b4[:, i], in_b4, proj_b4, False)}}
    scen = {"left": left, "from": cur, "proj_po": [rids[i] for i in proj_po], "proj_b4": [rids[i] for i in proj_b4], "teams": scen_teams}

    odds = {}
    for r in rids:
        i = ix[r]
        odds[r] = {"playoffs": float(np.mean(order[:, :4] == i) * 4), "title": float(np.mean(champ == i)),
                   "runner": float(np.mean(runner == i)), "third": float(np.mean(third == i)),
                   "bottom4": float(np.mean(order[:, 8:] == i) * 4), "last": float(np.mean(last == i)),
                   "lfinal": float(np.mean((lo1 == i) | (lo2 == i))),
                   "top_scorer": float(np.mean(top_sc == i)), "top_record": float(np.mean(order[:, 0] == i)),
                   "exp_wins": float(W[:, i].mean()), "exp_pf": float(PF[:, i].mean()),
                   # the middle 80% of simulated final win totals, as whole wins
                   "win_lo": float(np.quantile(W[:, i], 0.10, method="nearest")), "win_hi": float(np.quantile(W[:, i], 0.90, method="nearest")),
                   "mu": float(np.mean([mu[w][i] for w in range(first_trade_week, playoff_start)]) if first_trade_week < playoff_start else 0)}

    for n_, r in enumerate(sorted(rids, key=lambda r: -(odds[r]["exp_wins"] * 1e5 + odds[r]["exp_pf"]))):
        odds[r]["seed"] = n_ + 1

    # ---- every finished week's scores, and the odds as they stood after each week, rebuilt
    # Rebuilt, not recorded. Each point uses the records and rosters of that week. A player's strength is his
    # projection for the next week at the time (or the week after, if that one was his bye), carried through the rest
    # of the schedule with his bye week taken out, so an injury that came later is not known early. A player with no
    # projection in those two weeks was already out, and gets the projections of the weeks he actually returned for.
    mh = {w: get(f"{BASE}/league/{LEAGUE_ID}/matchups/{w}", f"matchups_{w}", 0.2) for w in range(1, last_done + 1)}
    week_games = {}
    for w, m in mh.items():
        by = {}
        for x in m:
            by.setdefault(x["matchup_id"], []).append((x["roster_id"], float(x.get("points") or 0.0)))
        week_games[w] = [v for k_, v in sorted(by.items(), key=lambda kv: kv[0] or 99) if k_ is not None and len(v) == 2]
    hproj, hpos = {}, dict(pos)
    for w in range(1, playoff_start):
        if w >= cur:
            for pid, pw in proj.items():
                if w in pw:
                    hproj.setdefault(pid, {})[w] = pw[w]
            continue
        for x in get(f"https://api.sleeper.app/projections/nfl/2026/{w}?season_type=regular", f"proj_{w}", 24 * 30):
            p_ = x.get("player") or {}
            if p_.get("position") not in POS_OK:
                continue
            st = x.get("stats") or {}
            if not st or st.get("gp", 1) == 0:
                continue
            pts = score_stats(st, sc, p_.get("position") == "DEF")
            if pts > 0.05:
                hproj.setdefault(x["player_id"], {})[w] = pts
                hpos.setdefault(x["player_id"], p_.get("position"))
    byes = {}                                                         # NFL team -> weeks it doesn't play (its defense has no projection)
    for tm, m_ in meta.items():
        if m_["pos"] == "DEF":
            byes[tm] = {w for w in range(1, playoff_start) if w not in hproj.get(tm, {})}
    team_of = lambda pid: pid if pid in byes else (pl.get(pid, {}).get("team"))
    NH = 20000
    rng_h = np.random.default_rng(SEED + 1)
    hist = {"weeks": list(range(0, last_done + 1)), "po": {str(r): [] for r in rids}, "b4": {str(r): [] for r in rids}, "sims": NH}
    for k in range(0, last_done):                                   # the league as it stood after week k
        ros_k = {x["roster_id"]: [p_ for p_ in (x.get("players") or [])] for x in mh[k + 1]}
        held = {p_ for v in ros_k.values() for p_ in v}
        pk = {}                                                       # what was known of each rostered player after week k
        for pid in held:
            pw = hproj.get(pid, {})
            base = pw.get(k + 1, pw.get(k + 2))
            off = byes.get(team_of(pid), set())
            pk[pid] = {w: (0.0 if w in off else base if base is not None else pw.get(w, 0.0)) for w in range(k + 1, playoff_start)}
        Wk = np.zeros(T); PFk = np.zeros(T)
        for w in range(1, k + 1):
            for (a, pa_), (b, pb_) in week_games[w]:
                PFk[ix[a]] += pa_; PFk[ix[b]] += pb_
                Wk[ix[a]] += 1.0 if pa_ > pb_ else 0.5 if pa_ == pb_ else 0.0
                Wk[ix[b]] += 1.0 if pb_ > pa_ else 0.5 if pa_ == pb_ else 0.0
        fa_k = {}
        for w in range(k + 1, playoff_start):
            d_ = {p_: [] for p_ in slots}
            for pid, pw in hproj.items():
                v = pw.get(w, 0.0)
                if pid not in held and v > 0 and hpos.get(pid) in d_:
                    d_[hpos[pid]].append(v)
            fa_k[w] = {p_: (sorted(v, reverse=True)[:6] + [0.0] * 6)[:6] for p_, v in d_.items()}
        Wn = np.tile(Wk, (NH, 1)); PFn = np.tile(PFk, (NH, 1))
        hz = rng_h.normal(0, HORIZON_SD, (NH, T))
        for w in range(k + 1, playoff_start):
            mu_w = np.array([week_points(ros_k[r], w, pk, hpos, slots, n_flex, fa_k) for r in rids])
            s_ = mu_w + rng_h.normal(0, WEEKLY_SD, (NH, T)) + hz
            pairs = [(a, b) for (a, _), (b, _) in week_games[w]] if w <= last_done else sched[w]
            for a, b in pairs:
                ia, ib = ix[a], ix[b]
                Wn[:, ia] += s_[:, ia] > s_[:, ib]
                Wn[:, ib] += s_[:, ib] > s_[:, ia]
            PFn += s_
        od = np.argsort(-(Wn * 1e5 + PFn), axis=1)
        for r in rids:
            hist["po"][str(r)].append(round(float(np.mean(od[:, :4] == ix[r]) * 4), 4))
            hist["b4"][str(r)].append(round(float(np.mean(od[:, 8:] == ix[r]) * 4), 4))
    for r in rids:                                                  # today's point is the page's own number
        hist["po"][str(r)].append(round(odds[r]["playoffs"], 4))
        hist["b4"][str(r)].append(round(odds[r]["bottom4"], 4))
    try:
        hall = hall_of_champions(lg, pl, last_done)
    except Exception as err:                                          # history is a nice-to-have: never let it stop the site updating
        print(f"hall: skipped ({type(err).__name__}: {err})", file=sys.stderr); hall = None
    results = {str(w): [[a, round(pa_, 2), b, round(pb_, 2)] for (a, pa_), (b, pb_) in g] for w, g in week_games.items()}
    week_mu = {str(w): {str(r): round(float(mu[w][ix[r]]), 1) for r in rids} for w in range(cur, playoff_start)}
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    if OFFLINE:
        now = dt.datetime.fromtimestamp((CACHE / "rosters.json").stat().st_mtime, dt.timezone.utc).replace(microsecond=0)
    out = {
        "asof": now.isoformat(), "season": 2026, "nfl_week": nfl_week, "last_done": last_done,
        "week_live": cur if week_started else None, "weeks": fut, "reg_end": playoff_start - 1,
        "playoff_start": playoff_start, "deadline": deadline, "roster_max": roster_max,
        "slots": slots, "n_flex": n_flex,
        "curve": {"A": A, "B": B, "kappa": KAPPA, "kappa_corr": kappa_corr, "n_picks": len(xs), "repl": repl},
        "round_val": {str(r): round(v, 3) for r, v in round_val.items()},
        "teams": [{"rid": r, **name[r], "w": wins[r], "l": losses[r], "t": ties[r], "pf": round(pf[r], 1),
                   "pa": round(pa[r], 1), "faab": faab[r], **{k: round(v, 4) for k, v in odds[r].items()}} for r in rids],
        "rosters": {str(r): [p for p in rosters[r] if p in meta] for r in rids},
        "reserve": {str(r): reserve[r] for r in rids},
        "picks": {str(r): {str(rd): o for rd, o in picks[r].items() if o} for r in rids},
        "players": {pid: {"n": meta[pid]["name"], "p": meta[pid]["pos"], "t": meta[pid].get("team") or "FA",
                          "inj": meta[pid].get("inj"),
                          "w": [round(proj.get(pid, {}).get(w, 0.0), 2) for w in fut],
                          "ros": round(ros_mean.get(pid, 0.0), 2), "g": round(ppg.get(pid, 0.0), 4),
                          **({"fp": card_pos[pid]} if card_pos.get(pid) and card_pos[pid] != meta[pid]["pos"] else {}),
                          **keep.get(pid, {})}
                    for pid in sorted(rostered) if pid in meta},
        "fa": {str(w): {p: [round(v, 2) for v in fa[w][p]] for p in fa[w]} for w in fut},
        "trades": trades, "games": games_out, "reg_games": playoff_start - 1, "card": card, "scen": scen,
        "hist": hist, "results": results, "week_mu": week_mu, "hall": hall,
        # what the page needs to rerun the season with a trade applied
        "sim": {"cur": cur, "live": week_started, "sd": WEEKLY_SD, "hsd": HORIZON_SD,
                "sched": {str(w): [list(g) for g in sched[w]] for w in sched},
                "live_pts": {str(r): round(live_pts.get(r, 0.0), 2) for r in rids} if week_started else {},
                "live_rem": {str(r): round(live_rem_mu.get(r, 0.0), 2) for r in rids} if week_started else {},
                "live_share": {str(r): round(live_share.get(r, 0.0), 4) for r in rids} if week_started else {}},
        "sims": N, "weekly_sd": WEEKLY_SD, "horizon_sd": HORIZON_SD,
    }
    (HERE / "data.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"week live={out['week_live']} trade weeks={fut[0]}-{fut[-1]} curve A={A:.3f} B={B:.5f} kappa={KAPPA:.3f} (r={kappa_corr:.2f})")
    print("round values (lineup pts/wk):", " ".join(f"R{r}:{v:.2f}" for r, v in round_val.items()))
    print("replacement:", {k: round(v, 1) for k, v in repl.items()})
    print(f"{'team':16s} rec   PF     mu   playoff title  lake")
    for t in sorted(out["teams"], key=lambda t: -(t["w"] * 1e4 + t["pf"])):
        print(f"{t['user']:16s} {t['w']}-{t['l']}  {t['pf']:6.1f} {t['mu']:5.1f}  {t['playoffs']:.3f}  {t['title']:.3f}  {t['last']:.3f}")
    return out


if __name__ == "__main__":
    main()
