// Purple Helm trade engine. Pure functions over the data snapshot; no DOM.
// Everything is in points per week added to a starting lineup.
function makeEngine(D) {
  const P = D.players, WEEKS = D.weeks;
  const A = D.curve.A, B = D.curve.B, K = D.curve.kappa;
  const FLEX = ['RB', 'WR', 'TE'];
  const SLOT_POS = Object.keys(D.slots);
  const ROUNDS = 15, CAP = 3, MAX_KEEP = 2, QB2_CREDIT = 0.2, EPS = 0.75;
  const NEXT_GAMES = D.reg_games || 14;                      // next season is counted over its regular season
  const EVEN_PTS = 10, GAP_EVEN = 20, GAP_LEAN = 40;         // total points, both seasons
  const V = n => A * Math.exp(-B * (n - 1));                 // roster value of overall pick n
  const mid = r => (r - 1) * 12 + 6.5;                       // draft order is drawn at the Rumble: value the middle slot
  const roundVal = r => K * V(mid(r));                       // lineup points per week of a pick in round r
  const ord = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const teamOf = {}; D.teams.forEach(t => { teamOf[t.rid] = t; });

  // ---------- this season: best projected lineup for one week
  function lineup(pids, wi) {
    const w = String(WEEKS[wi]), fa = D.fa[w];
    const by = {}; SLOT_POS.forEach(p => { by[p] = []; });
    pids.forEach(pid => {
      const pl = P[pid]; if (!pl || !by[pl.p]) return;
      const v = pl.w[wi] || 0; if (v > 0) by[pl.p].push([v, pid]);
    });
    let total = 0; const used = {}, left = [], starters = [];
    SLOT_POS.forEach(p => {
      used[p] = 0;
      const vs = by[p].sort((x, y) => y[0] - x[0]), n = D.slots[p];
      vs.slice(0, n).forEach(([v, pid]) => { total += v; starters.push(pid); });
      for (let i = vs.length; i < n; i++) { total += fa[p][used[p]] || 0; used[p]++; }
      if (FLEX.includes(p)) vs.slice(n).forEach(x => left.push(x));
    });
    left.sort((x, y) => y[0] - x[0]);
    left.slice(0, D.n_flex).forEach(([v, pid]) => { total += v; starters.push(pid); });
    for (let i = left.length; i < D.n_flex; i++) {
      let best = -1, bp = null;
      FLEX.forEach(p => { const v = fa[p][used[p]] || 0; if (v > best) { best = v; bp = p; } });
      total += Math.max(best, 0); if (bp) used[bp]++;
    }
    return { total, starters };
  }
  const nowVec = pids => WEEKS.map((_, wi) => lineup(pids, wi).total);
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

  // ---------- next season: best legal keeper package plus the picks a team will actually use
  // Every way to pay for a set of keepers. A keeper costs his round. Two at the same round push one a round
  // earlier (Rule 6). With no own pick in the round, an acquired pick in that round can pay (it still counts
  // toward the asset limit), or he costs the next round up.
  function payOptions(order, own, acq) {
    const out = [];
    const go = (i, used, spent, keep) => {
      if (i === order.length) { out.push({ keep, spent }); return; }
      const c = order[i];
      const at = cost => {
        while (used.includes(cost)) cost -= 1;
        if (cost < 1) return;
        if (own.has(cost)) { go(i + 1, used.concat(cost), spent, keep.concat(Object.assign({}, c, { paid: cost, with: null }))); return; }
        acq.forEach((a, j) => {
          if (a.round === cost && !spent.includes(j))
            go(i + 1, used.concat(cost), spent.concat(j), keep.concat(Object.assign({}, c, { paid: cost, with: j })));
        });
        at(cost - 1);
      };
      at(c.cost);
    };
    go(0, [], [], []);
    return out;
  }

  function candidates(pids) {
    return pids.filter(pid => P[pid] && P[pid].cost != null && P[pid].rank != null)
      .map(pid => ({ pid, cost: P[pid].cost, rank: P[pid].rank, pos: P[pid].p, val: V(P[pid].rank) }));
  }

  function bestPackage(pids, ownRounds, acquired) {
    const own = new Set(ownRounds);
    const acq = acquired.map(a => Object.assign({}, a, { val: V(mid(a.round)) })).sort((x, y) => y.val - x.val);
    const cands = candidates(pids);
    let best = null;
    const consider = (keep, spent) => {
      const room = CAP - keep.length - spent.length;
      if (room < 0) return;
      const qbs = keep.map((k, i) => [k, i]).filter(x => x[0].pos === 'QB').sort((x, y) => y[0].val - x[0].val).slice(1).map(x => x[1]);
      const kept = keep.reduce((s, k, i) => s + (qbs.includes(i) ? QB2_CREDIT : 1) * k.val, 0);
      const free = acq.filter((_, j) => !spent.includes(j));
      const retained = free.slice(0, room), dropped = free.slice(room);
      const ownPaid = keep.filter(k => k.with == null).map(k => k.paid);
      const vals = [...own].filter(r => !ownPaid.includes(r)).map(r => V(mid(r))).concat(retained.map(a => a.val)).sort((x, y) => y - x);
      const spots = ROUNDS - keep.length;
      let picks = 0;
      for (let i = 0; i < spots; i++) picks += i < vals.length ? vals[i] : V(mid(ROUNDS + 1));   // short a pick: a 16th-round pick
      const total = kept + picks;
      if (!best || total > best.total + 1e-9 || (Math.abs(total - best.total) <= 1e-9 && keep.length < best.keep.length))
        best = { total, keep, spent: spent.map(j => acq[j]), retained, dropped };
    };
    consider([], []);
    for (let i = 0; i < cands.length; i++) {
      payOptions([cands[i]], own, acq).forEach(o => consider(o.keep, o.spent));
      for (let j = i + 1; j < cands.length && MAX_KEEP >= 2; j++) {
        payOptions([cands[i], cands[j]], own, acq).forEach(o => consider(o.keep, o.spent));
        payOptions([cands[j], cands[i]], own, acq).forEach(o => consider(o.keep, o.spent));
      }
    }
    return best;
  }

  // what one player would cost this team to keep, on his own
  function soloCost(pid, ownRounds, acquired) {
    const pl = P[pid]; if (!pl || pl.cost == null) return null;
    const o = payOptions([{ pid, cost: pl.cost }], new Set(ownRounds), acquired.map(a => Object.assign({}, a)));
    if (!o.length) return null;
    const k = o[0].keep[0];
    return { paid: k.paid, withAcquired: k.with != null };
  }
  // value of keeping one player at a given round, in lineup points per week
  const keeperValue = (pid, cost) => (P[pid] && P[pid].rank != null && cost != null) ? K * (V(P[pid].rank) - V(mid(cost))) : null;

  // ---------- team state
  function teamState(rid, roster, picks) {
    const own = [], acquired = [];
    Object.keys(picks).forEach(r => picks[r].forEach(o => { if (o === rid) own.push(+r); else acquired.push({ round: +r, orig: o }); }));
    return { rid, roster, own, acquired };
  }
  const copyPicks = rid => { const picks = {}; Object.keys(D.picks[rid] || {}).forEach(r => { picks[r] = D.picks[rid][r].slice(); }); return picks; };
  const baseState = rid => teamState(rid, D.rosters[rid].slice(), copyPicks(rid));
  function applyTrade(rid, give, get) {
    const roster = D.rosters[rid].filter(p => !give.players.includes(p)).concat(get.players);
    const picks = copyPicks(rid);
    give.picks.forEach(pk => { const a = picks[pk.round] || []; const i = a.indexOf(pk.orig); if (i >= 0) a.splice(i, 1); });
    get.picks.forEach(pk => { (picks[pk.round] = picks[pk.round] || []).push(pk.orig); });
    return teamState(rid, roster, picks);
  }

  function side(rid, give, get) {
    const before = baseState(rid), after = applyTrade(rid, give, get);
    const nb = nowVec(before.roster), na = nowVec(after.roster);
    const d = na.map((x, i) => x - nb[i]);
    const reg = d.filter((_, i) => WEEKS[i] <= D.reg_end), po = d.filter((_, i) => WEEKS[i] >= D.playoff_start);
    const pb = bestPackage(before.roster, before.own, before.acquired);
    const pa = bestPackage(after.roster, after.own, after.acquired);
    // Total points. Regular-season weeks count in full. Bracket weeks count by the chance this team is playing in
    // one: the first bracket week for the top four and bottom four, the last two for the top four (final or
    // third-place game) and the two loser-bracket finalists.
    const t = teamOf[rid];
    const gw = WEEKS.map(w => w <= D.reg_end ? 1 : w === D.playoff_start ? Math.min(1, t.playoffs + t.bottom4) : Math.min(1, t.playoffs + (t.lfinal || 0)));
    const sum = a => a.reduce((x, y) => x + y, 0);
    const regTotal = sum(reg), regGames = reg.length;
    const poTotal = sum(d.map((x, i) => WEEKS[i] >= D.playoff_start ? x * gw[i] : 0));
    const poGames = sum(gw.filter((_, i) => WEEKS[i] >= D.playoff_start));
    const next = K * (pa.total - pb.total);
    return {
      rid, before, after, weekly: d, vecAfter: na, now: mean(d), nowReg: mean(reg), nowPO: mean(po),
      regTotal, regGames, poTotal, poGames, nowTotal: regTotal + poTotal, nowGames: regGames + poGames,
      nextTotal: next * NEXT_GAMES, nextGames: NEXT_GAMES, total: regTotal + poTotal + next * NEXT_GAMES,
      lineupBefore: mean(nb), lineupAfter: mean(na),
      next, pkgBefore: pb, pkgAfter: pa,
      picksIn: get.picks.reduce((s, p) => s + roundVal(p.round), 0), picksOut: give.picks.reduce((s, p) => s + roundVal(p.round), 0),
    };
  }

  // ---------- rules check
  function rules(s, give, get) {
    const out = [], nm = teamOf[s.rid].team;
    const pn = pid => P[pid].n;
    const count = s.after.roster.length - (D.reserve[s.rid] || []).length;
    if (count > D.roster_max)
      out.push({ lvl: 'warn', text: `${nm} would have ${count} players for ${D.roster_max} roster spots and must drop ${count - D.roster_max}.` });
    get.players.forEach(pid => {
      const pl = P[pid];
      if (pl.cost == null) { out.push({ lvl: 'info', text: `${pl.n} is a rental. ${pl.why}.` }); return; }
      const sc = soloCost(pid, s.after.own, s.after.acquired);
      const yrs = pl.yrs === 1 ? 'one keeper year left' : `${pl.yrs} keeper years left`;
      let txt = `${pl.n} keeps his keeper cost in a trade: a ${ord(pl.cost)} in 2027, ${yrs}.`;
      if (sc && sc.paid !== pl.cost) txt += ` ${nm} doesn't own a ${ord(pl.cost)}, so he would cost a ${ord(sc.paid)}.`;
      if (!sc) txt += ` ${nm} has no pick that could pay for him.`;
      out.push({ lvl: sc && sc.paid === pl.cost ? 'info' : 'warn', text: txt });
      if (pl.rule7) out.push({ lvl: 'warn', text: `${pl.n} has no projection for the rest of the season. If the injury is season-ending he can't be kept (Rule 7).` });
    });
    // own picks traded away: keepers whose cost round is leaving
    give.picks.filter(pk => pk.orig === s.rid).map(pk => pk.round).forEach(r => {
      const rows = s.after.roster.filter(pid => P[pid] && P[pid].cost === r && P[pid].rank != null).map(pid => {
        const sc = soloCost(pid, s.after.own, s.after.acquired);
        return { pid, sc, v: sc ? keeperValue(pid, sc.paid) : -99 };
      }).sort((x, y) => y.v - x.v).slice(0, 4);
      if (!rows.length) return;
      const names = rows.map(x => `${pn(x.pid)} (${x.sc ? (x.sc.withAcquired ? 'paid with an acquired ' + ord(x.sc.paid) : 'now a ' + ord(x.sc.paid)) : 'can no longer be kept, no earlier pick to pay with'})`).join(', ');
      const skip = rows.some(x => x.sc && x.sc.paid < r - 1);
      out.push({ lvl: 'warn', text: `${nm} is trading its ${ord(r)}, which changes the cost of players who cost a ${ord(r)} to keep: ${names}.`
        + (skip ? ' The league hasn\'t ruled on a keeper whose next round up is also gone; this assumes the next earlier round the team owns.' : '') });
    });
    // asset limit: keepers plus acquired picks
    const nb = s.before.acquired.length, na = s.after.acquired.length;
    if (na !== nb && na > 0) {
      const tail = na === 1 ? 'That leaves room for two keepers.'
        : na === 2 ? `${nm} could keep one player and both picks, or two players by moving one pick before keepers lock.`
        : na === 3 ? `${nm} could keep no players unless it moves a pick before keepers lock.`
        : `That is over the limit: ${na - CAP} would have to be moved before keepers lock, and ${nm} could keep no players.`;
      out.push({ lvl: na >= 2 ? 'warn' : 'info', text: `${nm} would hold ${na} acquired pick${na > 1 ? 's' : ''}. Keepers plus acquired picks can't pass ${CAP}. ${tail}` });
    }
    // best keepers
    const key = p => p.keep.map(k => k.pid + ':' + k.paid).sort().join('|');
    if (key(s.pkgBefore) !== key(s.pkgAfter)) {
      const show = p => p.keep.length ? p.keep.map(k => `${pn(k.pid)} (${ord(k.paid)})`).join(' and ') : 'no keepers';
      out.push({ lvl: 'info', text: `Best keepers for ${nm} would change from ${show(s.pkgBefore)} to ${show(s.pkgAfter)}.` });
    }
    s.pkgAfter.keep.forEach(k => {
      if (k.with != null) out.push({ lvl: 'info', text: `${pn(k.pid)} would be paid for with an acquired ${ord(k.paid)}. That uses two of the three asset slots for ${nm} (pending a commissioner ruling).` });
    });
    const nd = s.pkgAfter.dropped.length;
    if (nd) out.push({ lvl: 'warn', text: `The best plan for ${nm} leaves ${nd} acquired pick${nd > 1 ? 's' : ''} over the limit. ${nd > 1 ? 'They count' : 'It counts'} for nothing here; in practice ${nm} would trade ${nd > 1 ? 'them' : 'it'} again first.` });
    return out;
  }

  // ---------- verdict for trades the league baseline does not cover (players only, or picks only), in total points
  function verdict(a, b) {
    const f = x => (x >= 0.5 ? '+' : x <= -0.5 ? '−' : '') + Math.abs(Math.round(x));
    const na = teamOf[a.rid].team, nb = teamOf[b.rid].team;
    const ua = a.total, ub = b.total;
    const both = `${na} comes out ${f(ua)} points and ${nb} ${f(ub)} points, this season and next added together.`;
    if (Math.abs(ua) < EVEN_PTS && Math.abs(ub) < EVEN_PTS)
      return { band: 'Even', tone: 'even', favors: null, kind: 'flat', text: `Neither team moves by more than ${EVEN_PTS} points, this season and next added together.`, note: '' };
    const gap = Math.abs(ua - ub), win = ua > ub ? a.rid : b.rid, nw = ua > ub ? na : nb;
    if (ua <= -EVEN_PTS && ub <= -EVEN_PTS)
      return { band: 'Both teams lose', tone: 'lop', favors: null, kind: 'bad', text: both, note: '' };
    if (ua >= EVEN_PTS && ub >= EVEN_PTS)
      return { band: gap < GAP_EVEN ? 'Both teams gain' : `Both gain, ${nw} more`, tone: gap < GAP_EVEN ? 'even' : 'lean', favors: gap < GAP_EVEN ? null : win, kind: 'both', text: both, note: '' };
    return { band: gap < GAP_EVEN ? 'About even' : gap < GAP_LEAN ? `Leans ${nw}` : `Lopsided toward ${nw}`, tone: gap < GAP_EVEN ? 'even' : gap < GAP_LEAN ? 'lean' : 'lop',
      favors: gap < GAP_EVEN ? null : win, kind: 'tilt', text: both, note: '' };
  }

  // ---------- the league baseline: the fairness rule registered Nov 4 2026, the same math as the past trades
  // Buyer's points for every 100 points the seller gets. A player is worth what he adds to the receiving lineup at
  // his points per game so far, times the weeks left, less 20%. A pick is worth its chart value. The buyer is the
  // side that sends more pick value.
  const C = D.card || null;
  const cpos = pid => P[pid].fp || P[pid].p;
  const cval = pid => P[pid].g || 0;
  function cardBest(pids) {
    const left = pids.slice().sort((x, y) => cval(y) - cval(x));
    const used = new Set(); let pts = 0;
    ['QB', 'TE', 'DEF', 'RB', 'RB', 'WR', 'WR'].forEach(slot => {
      const c = left.find(p => !used.has(p) && cpos(p) === slot);
      if (c) { used.add(c); pts += cval(c); }
    });
    return pts + left.filter(p => !used.has(p) && FLEX.includes(cpos(p))).slice(0, 2).reduce((x, p) => x + cval(p), 0);
  }
  function cardScore(ridA, ridB, giveA, giveB) {
    if (!C) return { applies: false };
    if (!(giveA.players.length + giveB.players.length) || !(giveA.picks.length + giveB.picks.length)) return { applies: false };
    const sum = a => a.reduce((x, y) => x + y, 0);
    const pp = pk => C.pick_pts[pk.round] || 0;
    const one = (rid, give, get) => {
      const pre = D.rosters[rid].filter(p => !give.players.includes(p) && !get.players.includes(p));
      const withIn = pre.concat(get.players);
      const perWeek = get.players.length ? cardBest(withIn) - cardBest(pre) : 0;
      const picksIn = sum(get.picks.map(pp)), picksOut = sum(give.picks.map(pp));
      const players = C.trim * perWeek * C.weeks;
      return { rid, perWeek, players, picksIn, picksOut, total: players + picksIn };
    };
    const a = one(ridA, giveA, giveB), b = one(ridB, giveB, giveA);
    const buyer = (a.picksOut - a.picksIn) > (b.picksOut - b.picksIn) ? a : b, seller = buyer === a ? b : a;
    const zone = x => x == null ? null : x < C.band[0] ? 'below' : x > C.band[1] ? 'above' : 'inside';
    const score = seller.total > 0 ? 100 * buyer.total / seller.total : null;
    return { applies: true, buyer, seller, score, zone: zone(score) };
  }
  // ---------- the season simulation the page reruns with a trade applied: the same simulated seasons with and without it
  // A port of the standings simulation: each team's best projected lineup by week, week-to-week scoring noise, a
  // shared rest-of-season error per team, top four to the playoffs, bottom four to the loser bracket.
  const SIM = D.sim || null, NSIM = 12000;
  const RIDS = D.teams.map(t => t.rid), NT = RIDS.length, TI = {};
  RIDS.forEach((r, i) => { TI[r] = i; });
  const SIMW = []; if (SIM) for (let w = SIM.cur; w <= WEEKS[WEEKS.length - 1]; w++) SIMW.push(w);
  let Z = null, H = null, baseMu = null, baseOdds = null;
  // normal curve helpers for picked games: chance of a result, and the score gap that goes with a given chance
  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  const Phi = x => 0.5 * erfc(-x / Math.SQRT2);
  function invPhi(p) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // mu[team][index into WEEKS]. picked[week index][game index] = 1 (first team wins), 2 (second team wins) or 0 (simulate it).
  // A picked game is made to come out that way in every season: a season where it already did is left alone; where it
  // didn't, the two scores are redrawn from the seasons-like-this where it does. Each season is then weighted by how
  // likely its team strengths made the picks, so a team picked to win as an underdog is treated as a bit better than
  // projected in its other games too.
  function runSim(mu, picked) {
    const W = SIMW.length, off = SIM.live ? 1 : 0, pk = D.playoff_start - SIM.cur;
    const title = new Float64Array(NT), last = new Float64Array(NT), fw = new Float64Array(NT);
    const po = new Float64Array(NT), b4 = new Float64Array(NT), fpf = new Float64Array(NT);
    const gwin = SIMW.map((w, k) => new Float64Array(k < pk ? (SIM.sched[w] || []).length : 0));
    let wsum = 0, wsq = 0;
    const HB = 2 * D.reg_games + 2, hist = new Int32Array(NT * HB);         // final wins, counted in half wins
    const sc = SIMW.map(() => new Float64Array(NT)), wins = new Float64Array(NT), pf = new Float64Array(NT), key = new Float64Array(NT);
    const idx = RIDS.map((_, i) => i);
    const W0 = D.teams.map(t => t.w + 0.5 * (t.t || 0)), PF0 = D.teams.map(t => t.pf);
    const lp = RIDS.map(r => (SIM.live_pts[r] || 0) + (SIM.live_rem[r] || 0)), ls = RIDS.map(r => SIM.live_share[r] || 0), lq = ls.map(Math.sqrt);
    const sched = SIMW.map(w => (SIM.sched[w] || []).map(g => [TI[g[0]], TI[g[1]]]));
    for (let s = 0; s < NSIM; s++) {
      for (let i = 0; i < NT; i++) { wins[i] = W0[i]; pf[i] = PF0[i]; }
      const hb = s * NT;
      let wt = 1;
      for (let k = 0; k < W; k++) {
        const row = sc[k], zb = (s * W + k) * NT, liveK = SIM.live && k === 0;
        if (liveK) for (let i = 0; i < NT; i++) row[i] = lp[i] + Z[zb + i] * SIM.sd * lq[i] + H[hb + i] * ls[i];
        else for (let i = 0; i < NT; i++) row[i] = mu[i][k - off] + Z[zb + i] * SIM.sd + H[hb + i];
        if (k < pk) {
          const gs = sched[k], f = picked ? picked[k] : null;
          for (let j = 0; j < gs.length; j++) {
            const x = gs[j][0], y = gs[j][1];
            if (f && f[j]) {
              const a = f[j] === 1 ? x : y, b = f[j] === 1 ? y : x;        // a is picked to beat b
              const sa = SIM.sd * (liveK ? lq[a] : 1), sb = SIM.sd * (liveK ? lq[b] : 1), v = sa * sa + sb * sb;
              if (v > 1e-9) {
                const sg = Math.sqrt(v), d = row[a] - row[b];
                const m = d - (Z[zb + a] * sa - Z[zb + b] * sb);            // the gap this season's team strengths expect
                const q0 = Math.max(Phi(m / sg), 1e-12);                    // chance a wins, given those strengths
                wt *= q0;
                if (d <= 0) {                                               // it went the other way: redraw the gap from the seasons where a wins
                  const up = Phi(-(d - m) / sg);                            // share of gaps above this one; between q0 and 1 here
                  const u = Math.min(Math.max((up - q0) / (1 - q0), 1e-9), 1);
                  const d2 = Math.max(m - sg * invPhi(u * q0), 1e-6);
                  row[a] += (d2 - d) * sa * sa / v; row[b] -= (d2 - d) * sb * sb / v;
                }
              }
              wins[a]++;
            } else if (row[x] > row[y]) wins[x]++;
            else if (row[y] > row[x]) wins[y]++;
          }
          for (let i = 0; i < NT; i++) pf[i] += row[i];
        }
      }
      wsum += wt; wsq += wt * wt;
      // how often the first team wins each game, tallied once the season's weight is known
      for (let k = 0; k < pk; k++) { const gs = sched[k], f = picked ? picked[k] : null, row = sc[k]; for (let j = 0; j < gs.length; j++) if (f && f[j] ? f[j] === 1 : row[gs[j][0]] > row[gs[j][1]]) gwin[k][j] += wt; }
      for (let i = 0; i < NT; i++) key[i] = wins[i] * 1e5 + pf[i];
      for (let i = 0; i < NT; i++) { fw[i] += wt * wins[i]; fpf[i] += wt * pf[i]; if (!picked) hist[i * HB + Math.round(wins[i] * 2)]++; }
      idx.sort((x, y) => key[y] - key[x]);
      for (let n = 0; n < 4; n++) { po[idx[n]] += wt; b4[idx[NT - 1 - n]] += wt; }
      const r15 = sc[pk], ra = sc[pk + 1], rb = sc[pk + 2];
      const w1 = r15[idx[0]] >= r15[idx[3]] ? idx[0] : idx[3], w2 = r15[idx[1]] >= r15[idx[2]] ? idx[1] : idx[2];
      title[ra[w1] + rb[w1] >= ra[w2] + rb[w2] ? w1 : w2] += wt;
      const l1 = r15[idx[8]] >= r15[idx[11]] ? idx[11] : idx[8], l2 = r15[idx[9]] >= r15[idx[10]] ? idx[10] : idx[9];
      last[ra[l1] + rb[l1] >= ra[l2] + rb[l2] ? l2 : l1] += wt;
    }
    const q = (i, p) => { let c = 0; for (let h = 0; h < HB; h++) { c += hist[i * HB + h]; if (c >= p * NSIM) return h / 2; } return (HB - 1) / 2; };
    const share = a => Array.from(a, x => x / wsum);
    return { title: share(title), last: share(last), wins: share(fw), pf: share(fpf), po: share(po), b4: share(b4),
      games: gwin.map(g => share(g)), ess: wsum * wsum / wsq,
      winLo: picked ? null : RIDS.map((_, i) => q(i, 0.10)), winHi: picked ? null : RIDS.map((_, i) => q(i, 0.90)) };
  }
  function initSim() {
    let a = 20261109;                                          // fixed seed: the same trade always gives the same odds
    const r = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const g = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    Z = new Float32Array(NSIM * SIMW.length * NT); H = new Float32Array(NSIM * NT);
    for (let i = 0; i < Z.length; i++) Z[i] = g();
    for (let i = 0; i < H.length; i++) H[i] = g() * SIM.hsd;
    ensureBase();
    baseOdds = runSim(baseMu);
  }
  // ---------- before and after, in the plainest units: projected lineup points and where they rank, projected
  // record, and where each team's 2027 picks and keepers rank. Simulated odds ride along as a rough extra.
  let baseNext = null;
  const REGI = WEEKS.map((w, i) => i).filter(i => WEEKS[i] <= D.reg_end);
  const AVGI = REGI.length ? REGI : WEEKS.map((w, i) => i);
  const avgOver = v => AVGI.reduce((x, i) => x + v[i], 0) / AVGI.length;
  const rankOf = (vals, i) => 1 + vals.filter(x => x > vals[i] + 1e-9).length;
  function ensureBase() {
    if (baseMu) return;
    baseMu = RIDS.map(rid => nowVec(D.rosters[rid]));
    baseNext = RIDS.map(rid => { const s = baseState(rid); return K * bestPackage(s.roster, s.own, s.acquired).total; });
  }
  function outlook(a, b) {
    ensureBase();
    const mu = baseMu.slice(); mu[TI[a.rid]] = a.vecAfter; mu[TI[b.rid]] = b.vecAfter;
    const l0 = baseMu.map(avgOver), l1 = mu.map(avgOver);
    const n0 = baseNext, n1 = baseNext.slice(); n1[TI[a.rid]] = K * a.pkgAfter.total; n1[TI[b.rid]] = K * b.pkgAfter.total;
    const canSim = SIM && D.playoff_start - SIM.cur >= 0 && SIMW.length >= D.playoff_start - SIM.cur + 3;
    let o = null; if (canSim) { if (!Z) initSim(); o = runSim(mu); }
    const clamp = x => Math.min(1, Math.max(0, x));
    const one = rid => {
      const i = TI[rid], t = teamOf[rid];
      const out = { lineup: [l0[i], l1[i]], lineupRank: [rankOf(l0, i), rankOf(l1, i)], next: [n0[i], n1[i]], nextRank: [rankOf(n0, i), rankOf(n1, i)], teams: NT, avgWeeks: [WEEKS[AVGI[0]], WEEKS[AVGI[AVGI.length - 1]]] };
      if (o) {                                                // before = the standings page's numbers; after = before plus the paired change
        out.wins = [t.exp_wins, Math.max(0, t.exp_wins + o.wins[i] - baseOdds.wins[i])];
        const G = D.reg_games, cl = x => Math.min(G, Math.max(0, Math.round(x)));
        if (t.win_lo != null) out.winRange = [[cl(t.win_lo), cl(t.win_hi)], [cl(t.win_lo + o.winLo[i] - baseOdds.winLo[i]), cl(t.win_hi + o.winHi[i] - baseOdds.winHi[i])]];
        out.title = [t.title, clamp(t.title + o.title[i] - baseOdds.title[i])];
        out.last = [t.last, clamp(t.last + o.last[i] - baseOdds.last[i])];
        out.po = [t.playoffs, clamp(t.playoffs + o.po[i] - baseOdds.po[i])];
        out.b4 = [t.bottom4, clamp(t.bottom4 + o.b4[i] - baseOdds.b4[i])];
      }
      out.ny = nextPair(n0, n1, i);
      return out;
    };
    return { a: one(a.rid), b: one(b.rid) };
  }

  // ---------- next year, from where each team stands today (an estimate)
  // A team's strength is its picks-and-keepers value in points a week plus an unknown term nobody can see yet (how
  // the draft, waivers and health go). The unknown is drawn at three sizes, 7, 10 and 14 points a week, and the
  // three answers are shown as a range. 14 games against random opponents, top four by wins then points, the same
  // brackets as this year. Every run reuses the same draws, so a before and an after differ only by the trade.
  const NYN = 8000, NYW = D.reg_games || 14, NY_SD = [7, 10, 14];
  let NY = null, nyBase = null;
  function initNext() {
    let a = 20270901;
    const r = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const g = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    const Zs = new Float32Array(NYN * (NYW + 3) * NT), U = new Float32Array(NYN * NT), pair = new Uint8Array(NYN * NYW * NT);
    for (let i = 0; i < Zs.length; i++) Zs[i] = g();
    for (let i = 0; i < U.length; i++) U[i] = g();
    for (let b = 0; b < pair.length; b += NT) {                 // a fresh random set of matchups every week
      for (let i = 0; i < NT; i++) pair[b + i] = i;
      for (let i = NT - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), x = pair[b + i]; pair[b + i] = pair[b + j]; pair[b + j] = x; }
    }
    NY = { Zs, U, pair };
  }
  function nextRun(vals) {
    if (!NY) initNext();
    const wsd = D.weekly_sd || 23, { Zs, U, pair } = NY;
    const str = new Float64Array(NT), wins = new Float64Array(NT), pf = new Float64Array(NT), key = new Float64Array(NT), idx = RIDS.map((_, i) => i);
    const score = (s, w, i) => str[i] + wsd * Zs[(s * (NYW + 3) + w) * NT + i];
    return NY_SD.map(sd => {
      const title = new Float64Array(NT), po = new Float64Array(NT), last = new Float64Array(NT);
      for (let s = 0; s < NYN; s++) {
        for (let i = 0; i < NT; i++) { str[i] = vals[i] + sd * U[s * NT + i]; wins[i] = 0; pf[i] = 0; }
        for (let w = 0; w < NYW; w++) {
          const b = (s * NYW + w) * NT;
          for (let j = 0; j < NT; j += 2) {
            const x = pair[b + j], y = pair[b + j + 1], sx = score(s, w, x), sy = score(s, w, y);
            pf[x] += sx; pf[y] += sy; if (sx > sy) wins[x]++; else wins[y]++;
          }
        }
        for (let i = 0; i < NT; i++) key[i] = wins[i] * 1e5 + pf[i];
        idx.sort((x, y) => key[y] - key[x]);
        for (let n = 0; n < 4; n++) po[idx[n]]++;
        const one = (x, y) => score(s, NYW, x) >= score(s, NYW, y), two = (x, y) => score(s, NYW + 1, x) + score(s, NYW + 2, x) >= score(s, NYW + 1, y) + score(s, NYW + 2, y);
        const w1 = one(idx[0], idx[3]) ? idx[0] : idx[3], w2 = one(idx[1], idx[2]) ? idx[1] : idx[2];
        title[two(w1, w2) ? w1 : w2]++;
        const l1 = one(idx[8], idx[11]) ? idx[11] : idx[8], l2 = one(idx[9], idx[10]) ? idx[10] : idx[9];
        last[two(l1, l2) ? l2 : l1]++;
      }
      const f = a => Array.from(a, x => x / NYN);
      return { title: f(title), po: f(po), last: f(last) };
    });
  }
  // one team's next-year odds before and after: each a [low, high] across the three sizes of the unknown, plus the middle
  function nextPair(n0, n1, i) {
    if (!nyBase) { ensureBase(); nyBase = nextRun(baseNext); }
    const same = n1.every((x, j) => Math.abs(x - n0[j]) < 1e-9), after = same ? nyBase : (nextPair.memo && nextPair.memo.k === n1.join() ? nextPair.memo.v : nextRun(n1));
    if (!same) nextPair.memo = { k: n1.join(), v: after };
    const out = { same };
    ['title', 'po', 'last'].forEach(k => {
      const b = nyBase.map(r => r[k][i]), a = after.map(r => r[k][i]), mid = x => x.reduce((p, q) => p + q, 0) / x.length;
      out[k] = [[Math.min(...b), Math.max(...b)], [Math.min(...a), Math.max(...a)]];
      out[k + 'Mid'] = [mid(b), mid(a)];
    });
    return out;
  }

  // ---------- the call: four plain verdicts, from each team's odds this year and next
  // A team's change is counted in title points: its title chance, plus a third of its playoff chance, less a third of
  // its last-place chance, this year and next added together. Under one point either way counts as no real change.
  const W_PO = 1 / 3, W_LAST = 1 / 3, CALL_FLAT = 0.01, CALL_SHARE = 1 / 3;
  function tally(v) {
    const d = x => x ? x[1] - x[0] : 0;
    const now = d(v.title) + W_PO * d(v.po) - W_LAST * d(v.last);
    const next = v.ny ? d(v.ny.titleMid) + W_PO * d(v.ny.poMid) - W_LAST * d(v.ny.lastMid) : 0;
    return { now, next, net: now + next };
  }
  function call(a, b, view, giveA, giveB) {
    const na = teamOf[a.rid].team, nb = teamOf[b.rid].team, ta = tally(view.a), tb = tally(view.b);
    const empty = g => !g.players.length && !g.picks.length;
    const sign = x => x >= CALL_FLAT ? 1 : x <= -CALL_FLAT ? -1 : 0;
    const say = t => {
      const n = sign(t.now), x = sign(t.next), net = sign(t.net);
      if (n > 0 && x > 0) return 'gets better this year and next';
      if (n < 0 && x < 0) return 'gets worse this year and next';
      if (n > 0 && x < 0) return net > 0 ? 'gains more this year than it gives up next year' : net < 0 ? 'gives up more next year than it gains this year' : 'swaps next year for this year, about evenly';
      if (n < 0 && x > 0) return net > 0 ? 'gains more next year than it gives up this year' : net < 0 ? 'gives up more this year than it gains next year' : 'swaps this year for next year, about evenly';
      if (n > 0) return 'gets better this year'; if (x > 0) return 'gets better next year';
      if (n < 0) return 'gets worse this year'; if (x < 0) return 'gets worse next year';
      return 'barely moves';
    };
    const text = `${na} ${say(ta)}; ${nb} ${say(tb)}.`;
    const out = { a: ta, b: tb, text };
    if (empty(giveA) || empty(giveB)) {
      const who = empty(giveA) ? na : nb;
      return Object.assign(out, { key: 'open', band: 'Not a full trade yet', tone: 'open', text: `${who} isn't giving anything back. Add its side to get a verdict.` });
    }
    const sa = sign(ta.net), sb = sign(tb.net);
    if (sa === 0 && sb === 0) return Object.assign(out, { key: 'close', band: 'Too close to call', tone: 'close', text: 'The difference is smaller than the simulation can measure.' });
    if (sa < 0 && sb < 0) return Object.assign(out, { key: 'bad', band: 'Bad for both', tone: 'bad' });
    if (sa > 0 && sb > 0 && Math.min(ta.net, tb.net) >= CALL_SHARE * Math.max(ta.net, tb.net)) return Object.assign(out, { key: 'both', band: 'Works for both', tone: 'both' });
    const fav = ta.net >= tb.net ? na : nb;
    return Object.assign(out, { key: 'favors', band: 'Favors ' + fav, tone: 'favors', fav: ta.net >= tb.net ? a.rid : b.rid });
  }
  // what moving one pick changes next year, for the team getting it and the team giving it up
  function pickEffect(from, to, pick) {
    const g = { players: [], picks: [pick] }, none = { players: [], picks: [] };
    const sf = side(from, g, none), st = side(to, none, g);
    ensureBase();
    const n1 = baseNext.slice(); n1[TI[from]] = K * sf.pkgAfter.total; n1[TI[to]] = K * st.pkgAfter.total;
    const one = rid => { const i = TI[rid]; return { next: [baseNext[i], n1[i]], rank: [rankOf(baseNext, i), rankOf(n1, i)], ny: nextPair(baseNext, n1, i) }; };
    return { from: one(from), to: one(to), pick: roundVal(pick.round) };
  }

  // ---------- equal value, in points: what the points one team gets now would be worth as a pick, and the reverse
  const pickPts = r => roundVal(r) * NEXT_GAMES;
  const listRounds = rs => { const t = rs.map(r => 'a ' + ord(r)); return t.length > 1 ? t.slice(0, -1).join(', ') + ' and ' + t[t.length - 1] : t[0]; };
  function equalPick(points) {
    const v = r => Math.round(pickPts(r));
    if (points > pickPts(1) * 1.08) return `more than a 1st (${v(1)} points); about ${(points / pickPts(1)).toFixed(1)} firsts`;
    let near = 1;
    for (let r = 1; r <= ROUNDS; r++) if (Math.abs(pickPts(r) - points) < Math.abs(pickPts(near) - points)) near = r;
    if (Math.abs(pickPts(near) - points) <= 0.08 * Math.max(points, 1)) return `about a ${ord(near)} (${v(near)} points)`;
    const hi = pickPts(near) >= points ? near : near - 1, lo = hi + 1;       // hi is the earlier, more valuable round
    return lo > ROUNDS ? `less than a ${ord(ROUNDS)}` : `between a ${ord(lo)} (${v(lo)} points) and a ${ord(hi)} (${v(hi)})`;
  }
  function equalVerdict(x, y, giveX, getX) {
    const nx = teamOf[x.rid].team;
    const got = Math.round(x.nowTotal), paid = Math.round(-x.nextTotal), r = -x.nextTotal / x.nowTotal;
    const clean = !giveX.players.length && !getX.picks.length && giveX.picks.length;
    const what = clean ? `${listRounds(giveX.picks.map(p => p.round).sort((p, q) => p - q))}, worth ${paid} points next season` : `picks and keeper value worth ${paid} points next season`;
    const band = r > 1.1 ? `${nx} pays a premium` : r < 0.9 ? `${nx} gets a discount` : 'Equal value';
    const rate = `${paid} points equals adding ${(-x.nextTotal / x.nowGames).toFixed(1)} a week to ${nx} over its ${x.nowGames.toFixed(1)} expected games, and this trade adds ${(x.nowTotal / x.nowGames).toFixed(1)}.`;
    return { band, tone: r > 1.1 || r < 0.9 ? 'lean' : 'even', favors: r > 1.1 ? y.rid : r < 0.9 ? x.rid : null, kind: 'rental', ratio: r, buyer: x.rid,
      text: `${nx} gets ${got} points this season and pays ${what}. Equal value for ${got} points would be ${equalPick(x.nowTotal)}.`,
      note: `Put the other way, ${rate}` + (r > 1.1 ? ' Paying more than equal value is the usual price of points that arrive in the games deciding this season.' : '') };
  }

  function evaluate(ridA, ridB, giveA, giveB) {
    const a = side(ridA, giveA, giveB), b = side(ridB, giveB, giveA);
    const card = cardScore(ridA, ridB, giveA, giveB);
    const rental = (x, y) => x.now >= EPS && x.next <= -EPS && y.next >= EPS && x.nowTotal > 0;
    const v = rental(a, b) ? equalVerdict(a, b, giveA, giveB) : rental(b, a) ? equalVerdict(b, a, giveB, giveA) : verdict(a, b);
    const view = outlook(a, b);
    return { a, b, card, view, call: call(a, b, view, giveA, giveB), rulesA: rules(a, giveA, giveB), rulesB: rules(b, giveB, giveA), verdict: v };
  }
  const simCheck = () => { if (!SIM) return null; if (!Z) initSim(); return baseOdds; };

  // ---------- playoff scenarios: the regular season replayed with some winners picked by hand
  // picks: { "week:game index": 1 | 2 }, the game index being its place in that week's schedule.
  const canScen = () => !!SIM && D.playoff_start - SIM.cur > 0 && SIMW.length >= D.playoff_start - SIM.cur + 3;
  function scenGames() {
    if (!canScen()) return [];
    const known = {}; (D.games || []).forEach(g => { known[g.w + ':' + g.a + ':' + g.b] = g.pa; });
    const out = [];
    SIMW.forEach((w, k) => { if (w < D.playoff_start) (SIM.sched[w] || []).forEach((g, j) => {
      let pa = known[w + ':' + g[0] + ':' + g[1]];
      if (pa == null) { if (!Z) initSim(); pa = baseOdds.games[k][j]; }       // a week in progress: the page's own estimate
      out.push({ w, j, key: w + ':' + j, a: g[0], b: g[1], pa });
    }); });
    return out;
  }
  function scenario(picks) {
    if (!canScen()) return null;
    picks = picks || {};
    const pk = D.playoff_start - SIM.cur;
    const picked = SIMW.map((w, k) => k < pk ? (SIM.sched[w] || []).map((g, j) => picks[w + ':' + j] === 1 || picks[w + ':' + j] === 2 ? picks[w + ':' + j] : 0) : []);
    const nPicked = picked.reduce((n, f) => n + f.filter(x => x).length, 0), nGames = picked.reduce((n, f) => n + f.length, 0);
    if (nPicked && !Z) initSim();
    const o = nPicked ? runSim(baseMu, picked) : null;
    // the fewest and most wins each team can still finish with
    const lo = D.teams.map(t => t.w + 0.5 * (t.t || 0)), hi = lo.slice(), open = RIDS.map(() => 0);
    SIMW.forEach((w, k) => { if (k < pk) (SIM.sched[w] || []).forEach((g, j) => {
      const a = TI[g[0]], b = TI[g[1]], f = picked[k][j];
      if (f === 1) { lo[a]++; hi[a]++; } else if (f === 2) { lo[b]++; hi[b]++; } else { hi[a]++; hi[b]++; open[a]++; open[b]++; }
    }); });
    const count = fn => i => RIDS.reduce((n, _, u) => n + (u !== i && fn(u, i) ? 1 : 0), 0);
    const canCatch = count((u, i) => hi[u] >= lo[i]), surelyAbove = count((u, i) => lo[u] > hi[i]), surelyBelow = count((u, i) => hi[u] < lo[i]);
    const G = D.reg_games;
    const shade = (base, now, was) => {                        // today's published number plus the change the picks make
      if (!nPicked) return base;
      if (now <= 0 || now >= 1) return now;
      return Math.min(0.999, Math.max(0.001, base + now - was));
    };
    const rows = D.teams.map((t, i) => {
      const wins = nPicked ? Math.min(hi[i], Math.max(lo[i], t.exp_wins + o.wins[i] - baseOdds.wins[i])) : t.exp_wins;
      const half = 0.5 * (t.t || 0);                            // rec is whole wins; ties ride along unchanged
      return { rid: t.rid, open: open[i], lo: lo[i], hi: hi[i], wins, rec: open[i] ? Math.round(wins - half) : lo[i] - half,
        pf: o ? o.pf[i] : t.exp_pf, po: o ? shade(t.playoffs, o.po[i], baseOdds.po[i]) : t.playoffs, b4: o ? shade(t.bottom4, o.b4[i], baseOdds.b4[i]) : t.bottom4,
        // settled by record alone, whatever the points say (a tie in record goes to points, so a possible tie is not settled)
        poLock: canCatch(i) <= 3 ? 'in' : surelyAbove(i) >= 4 ? 'out' : null,
        b4Lock: surelyAbove(i) >= NT - 4 ? 'in' : surelyBelow(i) >= 4 ? 'out' : null,
        poWas: t.playoffs, b4Was: t.bottom4 };
    });
    rows.sort((x, y) => (y.wins - x.wins) || (y.pf - x.pf));
    return { rows, nPicked, nGames, ess: o ? o.ess : NSIM };
  }

  // ---------- magic numbers, the baseball way, counted on records
  // magic: a team's wins plus losses by the team it is racing for the last playoff spot, until it can't be caught.
  // shitty: its losses plus wins by the team it is racing for the last safe spot, until it can't catch up.
  // A tie on record goes to points, so a tie never counts as settled before the season is played.
  function clinch() {
    const TOP = 4, BOT = 4, G = D.reg_games;
    const cur = {}, left = {}, max = {};
    D.teams.forEach(t => { cur[t.rid] = t.w + (t.t || 0) / 2; left[t.rid] = Math.max(0, G - t.w - t.l - (t.t || 0)); max[t.rid] = cur[t.rid] + left[t.rid]; });
    const nth = (rid, of, n) => RIDS.filter(r => r !== rid).map(r => of[r]).sort((x, y) => y - x)[n - 1];
    const order = RIDS.slice().sort((x, y) => cur[y] - cur[x] || teamOf[y].pf - teamOf[x].pf);
    const over = RIDS.every(r => left[r] === 0), out = { over };
    RIDS.forEach(r => {
      const pos = order.indexOf(r);
      const magic = Math.floor(nth(r, max, TOP) - cur[r]) + 1;            // pass the most wins the fourth-best other team can still reach
      const shitty = Math.floor(max[r] - nth(r, cur, NT - BOT)) + 1;      // fall under the wins the eighth-best other team already has
      out[r] = over                                                        // season played: the standings are the answer, points tiebreak included
        ? { left: 0, magic, shitty, clinched: pos < TOP, locked: pos >= NT - BOT, out: pos >= TOP, safe: pos < NT - BOT }
        : { left: left[r], magic, shitty, clinched: magic <= 0, locked: shitty <= 0, out: max[r] < nth(r, cur, TOP), safe: cur[r] > nth(r, max, NT - BOT) };
    });
    return out;
  }

  // ---------- keeper board rows for one team
  function keeperBoard(rid) {
    const s = baseState(rid), pkg = bestPackage(s.roster, s.own, s.acquired);
    const inPkg = {}; pkg.keep.forEach(k => { inPkg[k.pid] = k; });
    const rows = s.roster.filter(pid => P[pid] && P[pid].cost != null && P[pid].rank != null).map(pid => {
      const pl = P[pid], sc = soloCost(pid, s.own, s.acquired);
      const cost = inPkg[pid] ? inPkg[pid].paid : (sc ? sc.paid : null);
      return { pid, name: pl.n, pos: pl.p, base: pl.cost, cost, yrs: pl.yrs, goes: Math.min(Math.ceil(pl.rank / 12), 16), rank: pl.rank,
        value: cost == null ? null : keeperValue(pid, cost), best: !!inPkg[pid], rule7: pl.rule7, why: pl.why, inj: pl.inj };
    }).sort((x, y) => (y.best - x.best) || ((y.value == null ? -99 : y.value) - (x.value == null ? -99 : x.value)));
    // Why the marked players are not simply the two highest values: one sentence per passed-over player.
    const pos = rows.filter(r => r.value != null && r.value > 0).sort((x, y) => y.value - x.value);
    const naive = pos.slice(0, MAX_KEEP), kept = rows.filter(r => r.best), notes = [];
    const full = pkg.keep.length + pkg.retained.length + pkg.spent.length >= CAP;
    naive.filter(r => !r.best).forEach(r => {
      const qb = r.pos === 'QB' && kept.find(k => k.pos === 'QB');
      const clash = kept.find(k => k.base === r.base);
      if (qb) notes.push({ pid: r.pid, kind: 'qb', text: `${r.name} would be a second kept quarterback behind ${qb.name}. A lineup starts one, so the second adds little.` });
      else if (kept.length < MAX_KEEP && full && pkg.retained.length) {
        const a = pkg.retained[pkg.retained.length - 1];
        notes.push({ pid: r.pid, kind: 'cap', text: `Keeping ${r.name} too would break the three-asset limit, because acquired picks count toward it. The ${ord(a.round)} from ${teamOf[a.orig].team} is worth more than he adds.` });
      } else if (clash) notes.push({ pid: r.pid, kind: 'clash', text: `${r.name} and ${clash.name} both cost a ${ord(r.base)}. Keeping both moves one of them a round earlier, and that costs more than ${r.name} adds.` });
      else notes.push({ pid: r.pid, kind: 'other', text: `${r.name} has a higher value on his own, but the marked players are worth more together once the picks they cost are counted.` });
    });
    if (!kept.length && rows.length) notes.push({ kind: 'none', text: pos.length ? 'No keeper is marked: every option is worth less than the picks this team would give up for it.' : 'No keeper is marked: no player here is worth more than the pick he would cost.' });
    return { rid, rows, pkg, notes, own: s.own, acquired: s.acquired, missing: Array.from({ length: ROUNDS }, (_, i) => i + 1).filter(r => !s.own.includes(r)) };
  }

  return { evaluate, side, lineup, nowVec, bestPackage, soloCost, keeperValue, keeperBoard, cardScore, simCheck, clinch, scenario, scenGames, canScen, pickEffect, nextRun, NY_SD, callRule: { W_PO, W_LAST, CALL_FLAT, CALL_SHARE }, _norm: { Phi, invPhi }, NSIM, roundVal, baseState, ord, V, mid, teamOf, EPS,
    bands: { EVEN_PTS, GAP_EVEN, GAP_LEAN, NEXT_GAMES } };
}
if (typeof module !== 'undefined') module.exports = { makeEngine };
