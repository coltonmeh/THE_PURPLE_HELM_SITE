const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync('index.html', 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message)));
vc.on('error', e => errors.push('console.error: ' + e));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.org/' });
const { document } = dom.window;
const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
const txt = el => el.textContent.replace(/\s+/g, ' ').trim();
console.log('asof:', txt(q('#asof')));
console.log('views on:', qa('.view.on').map(v => v.id));
console.log('standings rows:', qa('#view-standings .srow2').length, '| first:', txt(qa('#view-standings .srow2')[0]));
console.log('keeper cards:', qa('#view-keepers .kgrid .card').length, '| best rows:', qa('#view-keepers tr.best').length);
// Colton's keeper card
const kc = qa('#view-keepers .kgrid .card').find(c => txt(c).includes('Twinfan01'));
console.log('Colton keepers:', qa('tbody tr', kc).length ? '' : '', [...kc.querySelectorAll('tbody tr')].map(txt).join(' || '));
// trade: select Colton (rid 10) vs DocOaky, give Colton's 4th for Chuba Hubbard
const click = el => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const setSel = (id, v) => { const s = q(id); s.value = String(v); s.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
const D = JSON.parse(fs.readFileSync('data.json')); const rid = u => D.teams.find(t => t.user === u).rid;
setSel('#team-a', rid('Twinfan01')); setSel('#team-b', rid('DocOaky'));
console.log('analyze disabled when empty:', q('#analyze').disabled);
click(q(`[data-side="a"][data-pick="4:${rid('Twinfan01')}"]`));
const hub = Object.keys(D.players).find(k => D.players[k].n === 'Chuba Hubbard');
click(q(`[data-side="b"][data-player="${hub}"]`));
console.log('pressed:', qa('.asset[aria-pressed="true"]').map(txt).join(' ## '));
click(q('#analyze'));
console.log('readings:', [...document.querySelectorAll('.read > p')].map(e => txt(e).slice(0, 60)).join(' | '));
console.log('lines:', qa('.vlines .orow').map(txt).join(' ## '));
console.log('team cards:', qa('.tcard').map(txt).join(' ## ').slice(0, 1400));
console.log('dropdowns:', qa('.dd summary').map(txt).join(' / '), '| math teams:', qa('.dd .team-out').length);
click(q('.pickchip')); console.log('sheet:', txt(q('#sheet')).slice(0, 420));
click(q('#sheet-close')); console.log('sheet closed:', !q('#sheet'));
click(q('#change')); console.log('back to build, still pressed:', qa('.asset[aria-pressed="true"]').length);
// swap same team guard
setSel('#team-a', rid('DocOaky'));
console.log('after picking same team: a=', q('#team-a').value, 'b=', q('#team-b').value);
// tabs
click(q('#tab-keepers')); console.log('views on:', qa('.view.on').map(v => v.id), 'hash', dom.window.location.hash);
console.log('how:', txt(q('#view-how-it-works .rounds')).slice(0, 40));
console.log('double-escape check:', /&amp;#39;|&amp;amp;/.test(document.body.innerHTML));
console.log('ERRORS:', errors.length ? errors : 'none');
