const fs = require('fs');
const { makeEngine } = require('./engine.js');
const D = JSON.parse(fs.readFileSync('data.json'));
const E = makeEngine(D);
const P = D.players, T = D.teams;
const user = {}; T.forEach(t => user[t.rid] = t.user);
const rid = name => T.find(t => t.user === name).rid;
const pid = name => Object.keys(P).find(k => P[k].n === name);
// 1. dump lineup vectors and packages for cross-checks
const out = { now: {}, pkg: {} };
T.forEach(t => {
  const s = E.baseState(t.rid);
  out.now[t.rid] = E.nowVec(s.roster);
  const b = E.bestPackage(s.roster, s.own, s.acquired);
  out.pkg[t.rid] = { keep: b.keep.map(k => [P[k.pid].n, k.paid, k.with]), total: b.total, retained: b.retained.map(a => a.round), dropped: b.dropped.map(a => a.round) };
});
fs.writeFileSync('engine_dump.json', JSON.stringify(out));
const show = (title, a, b, ga, gb) => {
  const r = E.evaluate(rid(a), rid(b), ga, gb);
  console.log('\n== ' + title);
  for (const [s, n] of [[r.a, a], [r.b, b]])
    console.log(`  ${n}: TOTAL ${s.total.toFixed(0)} = now ${s.nowTotal.toFixed(0)} (${s.regTotal.toFixed(0)} reg x${s.regGames} + ${s.poTotal.toFixed(0)} bracket x${s.poGames.toFixed(1)}) + next ${s.nextTotal.toFixed(0)} | rate ${s.now.toFixed(2)} lineup ${s.lineupBefore.toFixed(1)}->${s.lineupAfter.toFixed(1)} | next ${s.next.toFixed(2)} | pkg ${s.pkgBefore.keep.map(k => P[k.pid].n + ' R' + k.paid)} -> ${s.pkgAfter.keep.map(k => P[k.pid].n + ' R' + k.paid)}`);
  console.log('  VERDICT:', r.verdict.band, '|', r.verdict.text, r.verdict.note, r.card.applies ? `| league score ${r.card.score && r.card.score.toFixed(1)}` : '| not on the league scale');
  r.rulesA.concat(r.rulesB).forEach(x => console.log('   -', x.lvl, x.text));
};
const g = (players = [], picks = []) => ({ players: players.map(pid), picks });
show('Colton trades his 4th to Dakota for Chuba Hubbard', 'Twinfan01', 'DocOaky', g([], [{ round: 4, orig: rid('Twinfan01') }]), g(['Chuba Hubbard']));
show('Pick for pick: Cole gives Uithoven 1st, gets Eric 2nd + 3rd', 'cdpetey10', 'ericdahlin14', g([], [{ round: 1, orig: rid('Uithoven') }]), g([], [{ round: 2, orig: rid('ericdahlin14') }, { round: 3, orig: rid('ericdahlin14') }]));
show('Player swap: Jack Kittle for Eric Purdy', 'jackntheboks1', 'ericdahlin14', g(['George Kittle']), g(['Brock Purdy']));
show('Rental: Nick gets McCaffrey from Dakota for 2nd', 'nickgbell', 'DocOaky', g([], [{ round: 2, orig: rid('nickgbell') }]), g(['Christian McCaffrey']));
show('Lopsided: Steve gives Nabers? (check roster) -> gives Tyler Warren for Scottie 15th', 'sekbo', 'Scottie234', g(['Tyler Warren']), g([], [{ round: 15, orig: rid('Scottie234') }]));
show('Cap: Westman (1 acquired) gets Ben 1st(from Chris)+Ben 2nd for Jeanty', 'RxDangles19', 'brobeck10', g(['Ashton Jeanty']), g([], [{ round: 1, orig: rid('topher057') }, { round: 2, orig: rid('brobeck10') }]));
