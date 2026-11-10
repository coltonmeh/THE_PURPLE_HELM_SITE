// Walk-through of the Playoff scenarios tab in a simulated browser. Run: node smoke3.js
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const errors = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(String(e.detail || e.message))); vc.on('error', e => errors.push(String(e)));
const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.org/#playoff-scenarios' });
const d = dom.window.document, q = s => d.querySelector(s), qa = s => [...d.querySelectorAll(s)];
const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '(missing)';
const click = el => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const D = JSON.parse(fs.readFileSync('data.json'));
const V = '#view-playoff-scenarios';
console.log('view on:', qa('.view.on').map(v => v.id), '| tabs:', qa('.tab').map(txt).join(' / '));
console.log('lede:', txt(q(V + ' .lede')));
console.log('path cards:', qa(V + ' .kgrid .card').length, '| options:', qa('#scen-team option').length);
qa(V + ' .kgrid .card').forEach(c => console.log('\n  ' + txt(c.querySelector('.rt-head')) + '\n   ' + [...c.querySelectorAll('.path')].map(txt).join('\n   ')));
console.log('\n  first table:', [...qa(V + ' .kgrid .card')[4].querySelectorAll('tr')].map(txt).join(' | '));
const set = (id, v) => { const s = q(id); s.value = String(v); s.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
set('#scen-team', 10);
console.log('\none team:', qa(V + ' .kgrid .card').length, '|', txt(q(V + ' .kgrid .card')).slice(0, 260), '| details open:', !!q(V + ' details[open]'));
set('#scen-team', 'race');
// simulator
click(q('[data-scen="sim"]'));
console.log('\nsim: weeks', qa('.wk').map(txt).join(' / '), '| games shown', qa('.game').length, '| rows', qa('#sim-result tbody tr').length);
console.log('  ', txt(q('#sim-result .note')));
console.log('  first rows:', qa('#sim-result tbody tr').slice(0, 5).map(txt).join(' || '));
const rid = u => D.teams.find(t => t.user === u).rid;
// Eric wins out
set('#quick-team', rid('ericdahlin14')); click(q('[data-act="winout"]'));
console.log('\nEric wins out:', txt(q('#sim-result .note')), '| chips', qa('.wk').map(txt).join(' / '));
console.log('  rows:', qa('#sim-result tbody tr').map(txt).join(' || '));
console.log('  pressed:', qa('.pickbtn[aria-pressed="true"]').map(txt).join(' ## '));
// toggle one pick off, then week 12, then favorites, then clear
const first = q('.pickbtn[aria-pressed="true"]'); click(first);
console.log('\nafter unpicking one:', txt(q('#sim-result .note')));
click(qa('.wk')[2]); console.log('week chip pressed:', txt(q('.wk[aria-pressed="true"]')), '| games', qa('.game').map(txt).join(' ## ').slice(0, 200));
click(q('[data-act="fav"]'));
console.log('\nfavorites fill:', txt(q('#sim-result .note')));
console.log('  rows:', qa('#sim-result tbody tr').map(txt).join(' || '));
console.log('  saved picks:', Object.keys(JSON.parse(dom.window.localStorage.getItem('ph-picks')).picks).length);
click(q('[data-act="clear"]'));
console.log('\ncleared:', txt(q('#sim-result .note')), '| clear disabled:', q('[data-act="clear"]').disabled);
click(q('#tab-standings')); console.log('standings pointer:', txt(q('#view-standings > p.note')));
console.log('how it works has scenarios card:', qa('#view-how-it-works h3').map(txt).join(' / '));
console.log('ERRORS:', errors.length ? errors : 'none');
