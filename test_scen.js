// Checks for the scenario simulator. Run: node test_scen.js
const fs = require('fs');
const D = JSON.parse(fs.readFileSync('data.json'));
const { makeEngine } = require('./engine.js');
const E = makeEngine(D);
const T = {}; D.teams.forEach(t => { T[t.rid] = t; });
const rid = u => D.teams.find(t => t.user === u).rid;
let fails = 0;
// PH_SOFT=1 (the scheduled build): comparisons that depend on simulation noise warn instead of stopping the publish
const SOFT = !!process.env.PH_SOFT;
const ok = (name, cond, extra, noisy) => { if (!cond && !(SOFT && noisy)) fails++; console.log((cond ? 'ok   ' : SOFT && noisy ? 'WARN ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
if (!E.canScen()) { console.log('The regular season is over: nothing to simulate, checks skipped.'); process.exit(0); }

// 1. normal-curve helpers
const { Phi, invPhi } = E._norm;
ok('Phi(0)=0.5', Math.abs(Phi(0) - 0.5) < 1e-7);
ok('Phi(1.96)', Math.abs(Phi(1.959964) - 0.975) < 1e-6, Phi(1.959964).toFixed(7));
ok('invPhi(0.975)', Math.abs(invPhi(0.975) - 1.959964) < 1e-5, invPhi(0.975).toFixed(6));
let worst = 0; for (let p = 1e-6; p < 1; p += 0.00137) worst = Math.max(worst, Math.abs(Phi(invPhi(p)) - p) / Math.min(p, 1 - p));
ok('Phi(invPhi(p)) round trip', worst < 1e-5, 'worst relative error ' + worst.toExponential(2));

// 2. same engine output for trades as the engine before this change, on the same data
if (fs.existsSync('./engine.bak.js')) {
  const E0 = require('./engine.bak.js').makeEngine(D);
  const b0 = E0.simCheck(), b1 = E.simCheck();
  const same = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
  ok('no-trade sim unchanged: title, last, wins, ranges', same(b0.title, b1.title) && same(b0.last, b1.last) && same(b0.wins, b1.wins) && same(b0.winLo, b1.winLo) && same(b0.winHi, b1.winHi));
  const pid = n => Object.keys(D.players).find(k => D.players[k].n === n);
  const ga = { players: [], picks: [{ round: 2, orig: rid('nickgbell') }] }, gb = { players: [pid('Christian McCaffrey')], picks: [] };
  const keep = v => JSON.stringify(['a', 'b'].map(k => ['lineup', 'lineupRank', 'next', 'nextRank', 'wins', 'winRange', 'title', 'last'].map(f => v[k][f])));
  const v0 = keep(E0.evaluate(rid('nickgbell'), rid('DocOaky'), ga, gb).view), v1 = keep(E.evaluate(rid('nickgbell'), rid('DocOaky'), ga, gb).view);
  ok('trade before/after view unchanged', v0 === v1);
}

// 3. no picks = today's published numbers
const s0 = E.scenario({});
ok('no picks: playoffs and bottom four equal the standings numbers', s0.rows.every(r => r.po === T[r.rid].playoffs && r.b4 === T[r.rid].bottom4));
ok('no picks: every remaining game open', s0.nGames === E.scenGames().length && s0.nPicked === 0, `${s0.nGames} games`);
const base = E.simCheck();
console.log('     page sim vs data build (playoffs):', D.teams.map((t, i) => `${t.user} ${(100 * base.po[i]).toFixed(1)}/${(100 * t.playoffs).toFixed(1)}`).join('  '));
ok('page sim within 1.5 points of the data build on playoffs and bottom four', D.teams.every((t, i) => Math.abs(base.po[i] - t.playoffs) < 0.015 && Math.abs(base.b4[i] - t.bottom4) < 0.015), '', true);

// 4. picked games against the data build's own conditional numbers
const games = E.scenGames();
const gkey = (w, a, b) => games.find(g => g.w === w && ((g.a === a && g.b === b) || (g.a === b && g.b === a)));
let worstGap = 0, worstTxt = '';
for (const g of D.games) {
  const sg = gkey(g.w, g.a, g.b);
  for (const [pick, ia, ib] of [[1, 0, 1], [2, 1, 0]]) {
    const sc = E.scenario({ [sg.key]: pick });
    const row = r => sc.rows.find(x => x.rid === r);
    for (const [r, po, b4] of [[g.a, g.a_po, g.a_b4], [g.b, g.b_po, g.b_b4]]) {
      const i = r === g.a ? ia : ib;
      for (const [got, want, lab] of [[row(r).po, po[i], 'playoffs'], [row(r).b4, b4[i], 'bottom four']]) {
        if (want == null) continue;
        const gap = Math.abs(got - want);
        if (gap > worstGap) { worstGap = gap; worstTxt = `Wk ${g.w} ${T[g.a].user} v ${T[g.b].user}, ${pick === 1 ? T[g.a].user : T[g.b].user} picked: ${T[r].user} ${lab} ${(100 * got).toFixed(1)} vs ${(100 * want).toFixed(1)}`; }
      }
    }
  }
}
ok('one picked game: both teams within 2.5 points of the data build, all 30 games both ways', worstGap < 0.025, 'worst: ' + worstTxt, true);

// 5. a team picked to win out or lose out, against the by-record table
const left = D.scen.left;
let rows = [];
for (const t of D.teams) for (const all of [true, false]) {
  const picks = {}; games.filter(g => g.a === t.rid || g.b === t.rid).forEach(g => { picks[g.key] = (g.a === t.rid) === all ? 1 : 2; });
  const sc = E.scenario(picks), r = sc.rows.find(x => x.rid === t.rid), want = D.scen.teams[t.rid].rec[all ? left : 0];
  rows.push({ t, all, r, want, ess: sc.ess });
}
for (const x of rows) console.log(`     ${x.t.user.padEnd(14)} ${x.all ? 'wins out ' : 'loses out'} rec ${x.r.rec}  playoffs ${(100 * x.r.po).toFixed(1)} (table ${x.want[2] == null ? 'n/a' : (100 * x.want[2]).toFixed(1)})  bottom four ${(100 * x.r.b4).toFixed(1)} (table ${x.want[3] == null ? 'n/a' : (100 * x.want[3]).toFixed(1)})  lock ${x.r.poLock}/${x.r.b4Lock}  seasons' worth ${Math.round(x.ess)}`);
const gaps = rows.filter(x => x.want[2] != null).map(x => Math.max(Math.abs(x.r.po - x.want[2]), Math.abs(x.r.b4 - x.want[3])));
ok('win out / lose out within 5 points of the by-record table', !gaps.length || Math.max(...gaps) < 0.05, 'worst ' + (gaps.length ? (100 * Math.max(...gaps)).toFixed(1) : 'n/a'), true);
ok('records are exact when all of a team\'s games are picked', rows.every(x => x.r.rec === x.t.w + (x.all ? left : 0) && x.r.open === 0));

// 6. every game picked: four in, four in the bottom, records add up
const fav = {}; games.forEach(g => { fav[g.key] = g.pa >= 0.5 ? 1 : 2; });
const sf = E.scenario(fav);
console.log('     favorites win out:', sf.rows.map(r => `${T[r.rid].user} ${r.rec}-${D.reg_games - r.rec} ${r.poLock || (100 * r.po).toFixed(0) + '%'}/${r.b4Lock || (100 * r.b4).toFixed(0) + '%'}`).join('  '), '| seasons\' worth', Math.round(sf.ess));
ok('all picked: wins total = games', sf.rows.reduce((n, r) => n + r.rec, 0) === D.teams.reduce((n, t) => n + t.w, 0) + games.length);
ok('all picked: playoff chances sum to 4, bottom four to 4', Math.abs(sf.rows.reduce((n, r) => n + (r.poLock ? (r.poLock === 'in' ? 1 : 0) : r.po), 0) - 4) < 0.02 && Math.abs(sf.rows.reduce((n, r) => n + (r.b4Lock ? (r.b4Lock === 'in' ? 1 : 0) : r.b4), 0) - 4) < 0.02);
const up = {}; games.forEach(g => { up[g.key] = g.pa >= 0.5 ? 2 : 1; });
const su = E.scenario(up);
console.log('     underdogs win out:', su.rows.map(r => `${T[r.rid].user} ${r.rec}-${D.reg_games - r.rec} ${r.poLock || (100 * r.po).toFixed(0) + '%'}/${r.b4Lock || (100 * r.b4).toFixed(0) + '%'}`).join('  '), '| seasons\' worth', Math.round(su.ess));
// 7. locks never contradict the simulation
const bad = [];
for (const sc of [s0, sf, su, ...rows.map(x => E.scenario(Object.fromEntries(games.filter(g => g.a === x.t.rid || g.b === x.t.rid).map(g => [g.key, (g.a === x.t.rid) === x.all ? 1 : 2]))))])
  for (const r of sc.rows) {
    if (r.poLock === 'in' && r.po < 0.999 && sc.nPicked) bad.push(['po in', r.rid, r.po]);
    if (r.poLock === 'out' && r.po > 0.001 && sc.nPicked) bad.push(['po out', r.rid, r.po]);
    if (r.b4Lock === 'in' && r.b4 < 0.999 && sc.nPicked) bad.push(['b4 in', r.rid, r.b4]);
    if (r.b4Lock === 'out' && r.b4 > 0.001 && sc.nPicked) bad.push(['b4 out', r.rid, r.b4]);
  }
ok('a result settled by record is never contradicted by the simulation', bad.length === 0, JSON.stringify(bad.slice(0, 4)));
let t0 = Date.now(); for (let i = 0; i < 5; i++) E.scenario(fav); console.log('     time per scenario run:', ((Date.now() - t0) / 5).toFixed(0), 'ms');
console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
