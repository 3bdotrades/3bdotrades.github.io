'use strict';
// Keeps the counts behind the four Live rates of the roadmap page.
//
// The fleet dashboard is rebuilt every ten minutes and each build is a commit in its public repository. This script
// reads the builds it has not read yet, one after the other, and counts what the dashboard itself shows:
//
//   evals             passed = the row says PASSED.
//                     blown  = the row is liquidated, has no room left, or leaves the dashboard without having passed
//                              (an eval the firm closed leaves the same way and is a blown eval in the fleet's ledger too).
//   funded first win  won    = the account reaches its aim, or moves to the flips.
//                     lost   = it is liquidated, or leaves the dashboard without that win.
//                     A flip account that is sent back to the funded table is not a first funded account: not counted.
//   flip days         a flip account's day P&L on a trading day: above zero is a day won, below zero a day lost.
//                     25K and 50K accounts are counted apart (they flip different boxes).
//
// The counts start from the dashboard's own Lifetime table: every build that carries the table sets them to it, and
// builds without it are counted on from there. (The table was on the dashboard on 10 Nov 2026, 19:28 to 19:47 UTC.)
// An account that comes back after it was counted as gone gets that count taken back.
//
//   node tools/track.js <folder> <clone of the dashboard repository>     keeps <folder>/g1.json and <folder>/v2.json
//
// A counts file: counts = for each rate [won, finished], what the page reads; base = the last Lifetime table read;
// day and today = the trading day being counted and the flip days seen on it so far; acc = what is remembered of each
// account (by a hash of its number); log = what was counted and when.
// marks = each eval that passed and each new funded account that showed up, with the time and the firm and size
// ("topstep|50"): the page uses them to know which of the funded accounts it holds as "not on the dashboard yet" have
// come onto it since.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');

const FLEETS = ['g1', 'v2'], KEYS = ['pass', 'win', 'flip', 'flip25'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', minus: '-' };
const KEEP_GONE_DAYS = 10, LOG_LINES = 400, MARK_LINES = 400, SAVE_EVERY = 200;

function entity(m, e){
  if (e[0] !== '#') return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  const c = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m;
}
function text(html){ return String(html).replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity).replace(/−/g, '-').replace(/\s+/g, ' ').trim(); }
function money(s){ const m = /([+-]?)\$([\d,]+(?:\.\d+)?)/.exec(s || ''); return m ? (m[1] === '-' ? -1 : 1) * Number(m[2].replace(/,/g, '')) : null; }
function int(s){ return Number(String(s).replace(/,/g, '')); }
// account numbers stay out of the saved file: an account is remembered by a short hash of its number
function key(id){ return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12); }
// the size is in the account number at Lucid (LFF025..., LFE050...) and Tradeify (...DFYSLX25...); every other flip account is a 50K
function small(id){ const m = /^LF[EF]0?(25|50|100|150)/i.exec(id) || /DFYSLX?(25|50|100|150)/i.exec(id); return !!m && +m[1] === 25; }
// "Topstep XFA", "Aqua funded" and "Tradeify Flex" are the funded accounts of Topstep, Aqua and Tradeify
function firmName(s){ return String(s || '').replace(/\s+(XFA|funded|Flex)$/i, '').trim(); }
// a firm and size the way the page names them: "lucid|25", "blueguardian|50". An eval with no size in its number is sized by its target.
function unit(r, isEval){
  let m = /^LF[EF]0?(25|50|100|150)/i.exec(r.id) || /DFYSLX?(25|50|100|150)/i.exec(r.id), size = m ? +m[1] : 50;
  if (!m && isEval && r.target > 0) size = r.target <= 1600 ? 25 : r.target <= 3500 ? 50 : r.target <= 6500 ? 100 : 150;
  return r.firm.toLowerCase().replace(/[^a-z]/g, '') + '|' + size;
}

// one table of accounts: its rows, or null when it is not the table this script knows
function pane(sec, k, name){
  const a = sec.indexOf('id="p-' + k + '-' + name + '"'); if (a < 0) return null;
  const b = sec.indexOf('</table>', a); if (b < 0) return null;
  const rows = sec.slice(a, b).split(/<tr[\s>]/i).slice(1).map(tr => { const cells = []; tr.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (m, c) => { cells.push(text(c)); return ''; }); return cells; });
  const h = rows[0];
  if (!h || h.length < 6 || h[0] !== 'Account' || !/day/i.test(h[2]) || !/total/i.test(h[3]) || !/room/i.test(h[4]) || !/last trade/i.test(h[5])) return null;
  return rows.slice(1).filter(c => c.length >= 6 && c[0]).map(c => {
    const total = c[3], d = /^(\d\d-\d\d)\b/.exec(c[5]), of = /of \$([\d,]+)/.exec(total);
    return { id: c[0], firm: firmName(c[1]), passed: /PASSED/i.test(total), dead: /LIQUIDATED|RETIRED/i.test(total),
      dayPnl: money(c[2]), pnl: money(total), target: of ? int(of[1]) : null, room: money(c[4]), day: d ? d[1] : '' };
  });
}

// What one build of the dashboard shows for a fleet, or null when its section cannot be trusted:
// the three tables have to be there with as many rows as the tabs above them say.
function read(html, k){
  const a = html.indexOf('id="eng-' + k + '"'); if (a < 0) return null;
  let b = html.length;
  FLEETS.forEach(o => { const i = o === k ? -1 : html.indexOf('id="eng-' + o + '"', a + 1); if (i > a && i < b) b = i; });
  const f = html.indexOf('class="foot"', a); if (f > a && f < b) b = f;
  const sec = html.slice(a, b), snap = { day: '', date: '', life: null };
  for (const name of ['eval', 'funded', 'flip']){ const rows = pane(sec, k, name); if (!rows) return null; snap[name] = rows; }
  const tabs = /Evals ?(\d+) ?Fundeds ?(\d+) ?Flips ?(\d+)/.exec(text(sec));
  if (!tabs || +tabs[1] !== snap.eval.length || +tabs[2] !== snap.funded.length || +tabs[3] !== snap.flip.length) return null;
  const ids = {}; let twice = false;
  snap.eval.concat(snap.funded, snap.flip).forEach(r => { if (ids[r.id]) twice = true; ids[r.id] = 1; });
  if (twice) return null;
  // the trading day (it rolls at 18:00 ET), and the date a trade of that day carries in the "Last trade" column
  const fi = html.indexOf('class="foot"'), day = /Trading day ([A-Za-z]{3}) (\d{1,2}) ([A-Za-z]{3})/.exec(text(html.slice(fi < 0 ? 0 : fi))), mon = day ? MONTHS.indexOf(day[3].toLowerCase()) : -1;
  if (!day || mon < 0) return null;
  snap.day = day[1] + ' ' + (+day[2]) + ' ' + day[3];
  snap.date = ('0' + (mon + 1)).slice(-2) + '-' + ('0' + (+day[2])).slice(-2);
  // the Lifetime table, when the build has one: for each rate [won, finished]
  const la = sec.indexOf('<h2>Lifetime</h2>');
  if (la >= 0){
    const lb = sec.indexOf('<h2', la + 4), t2 = text(sec.slice(la, lb > la ? lb : sec.length)), life = {};
    [['pass', /Evals ([\d,]+) passed\D+?([\d,]+) blown/i], ['win', /Funded first win ([\d,]+) won\D+?([\d,]+) lost/i],
     ['flip', /Flip days 50K ([\d,]+) won\D+?([\d,]+) lost/i], ['flip25', /Flip days 25K ([\d,]+) won\D+?([\d,]+) lost/i]].forEach(x => {
      const m = x[1].exec(t2); if (m) life[x[0]] = [int(m[1]), int(m[1]) + int(m[2])];
    });
    if (KEYS.every(x => life[x])) snap.life = life;
  }
  return snap;
}

function copy(o){ return JSON.parse(JSON.stringify(o)); }
function dayNo(iso){ return Math.floor(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / 864e5); }
// the flip days seen on the trading day being counted, per size
function todays(st){
  const s = { flip: [0, 0], flip25: [0, 0] };
  Object.keys(st.today).forEach(h => { const t = st.today[h], k = t[0] ? 'flip25' : 'flip'; s[k][1]++; if (t[1] > 0) s[k][0]++; });
  return s;
}

// One build. st = the counts file so far (null before the first one), snap = what the build shows, meta = { sha, built }.
// What is remembered of an account: p = its table (e eval, f funded, x flip), f = its firm, z = its result is counted,
// r = a funded stage that is not its first, gone = the date it left the dashboard, u = it was counted because it left.
function step(st, snap, meta){
  const first = !st;                                           // the first build read: what it shows was there before
  st = st ? copy(st) : { v: 2, at: '', built: '', day: '', counts: null, flipDone: null, base: null, today: {}, marks: [], acc: {}, log: [] };
  if (!st.marks) st.marks = [];                                // a file from before the marks were kept
  const acc = st.acc, seen = {}, when = meta.built.slice(0, 16).replace('T', ' ');
  const mark = (what, r, isEval) => { if (!first) st.marks.push([meta.built.slice(0, 16), what, unit(r, isEval)]); };
  // a new trading day: the flip days of the one before are final
  if (snap.day !== st.day){
    if (st.counts){ const s = todays(st); ['flip', 'flip25'].forEach(k => { st.flipDone[k][0] += s[k][0]; st.flipDone[k][1] += s[k][1]; }); }
    st.today = {}; st.day = snap.day;
  }
  // a build with the Lifetime table: the counts are the table's, and what its rows show is in them already
  const based = !!snap.life;
  if (based){ st.counts = copy(snap.life); st.base = { built: meta.built, counts: copy(snap.life) }; }
  if (!st.counts) return st;
  const note = (what, firm, h) => { if (!based) st.log.push(when + ' ' + what + ' · ' + firm + ' ' + h.slice(0, 6)); };
  const add = (k, won) => { if (!based){ st.counts[k][1]++; if (won) st.counts[k][0]++; } };
  const out = r => r.dead || (r.room !== null && r.room <= 0);
  // an account that was gone is back: if it was counted because it left and it is not out after all, that count is taken back
  const back = (a, r, k, h, stillOut) => {
    if (a.u){
      if (!stillOut && !based){ st.counts[k][1]--; delete a.z; note('back on the dashboard: its count is taken back', r.firm, h); }
      delete a.u;
    }
    delete a.gone;
  };

  snap.eval.forEach(r => {
    const h = key(r.id); seen[h] = 1;
    let a = acc[h]; const isNew = !a || a.p !== 'e';
    if (isNew) a = acc[h] = { p: 'e', f: r.firm };
    if (a.gone) back(a, r, 'pass', h, out(r) && !r.passed);
    if (a.z) return;
    if (!r.passed && !out(r)) return;
    a.z = 1;
    // a row that shows up with its result already on it is counted only when that result is from this trading day
    if (isNew && r.day !== snap.date){ note('eval listed with an older result: not counted', r.firm, h); return; }
    if (r.passed) mark('pass', r, true);
    add('pass', r.passed); note(r.passed ? 'eval passed' : 'eval blown', r.firm, h);
  });

  snap.funded.forEach(r => {
    const h = key(r.id); seen[h] = 1;
    let a = acc[h]; const isNew = !a || a.p === 'e';
    if (isNew){ a = acc[h] = { p: 'f', f: r.firm }; if (!r.dead) mark('wired', r, false); }
    else if (a.p === 'x'){ a = acc[h] = { p: 'f', f: r.firm, r: 1 }; note('flip account back in the funded table: no first win to count', r.firm, h); }
    const won = r.target > 0 && r.pnl !== null && r.pnl >= r.target, lost = !won && out(r);
    if (a.gone) back(a, r, 'win', h, lost);
    if (a.z || a.r || (!won && !lost)) return;
    a.z = 1;
    if (isNew && r.day !== snap.date){ note('funded account listed with an older result: not counted', r.firm, h); return; }
    add('win', won); note(won ? 'funded account won' : 'funded account lost', r.firm, h);
  });

  snap.flip.forEach(r => {
    const h = key(r.id); seen[h] = 1;
    let a = acc[h];
    if (a && a.p === 'f'){
      if (a.gone) back(a, r, 'win', h, false);
      if (!a.z && !a.r){ add('win', true); note('funded account won (now in the flips)', r.firm, h); }
      a = acc[h] = { p: 'x', f: r.firm };
    } else if (!a || a.p !== 'x'){
      // never seen as a funded account: an older flip account put on the dashboard, no first win to count
      note('new in the flips: no first win counted', r.firm, h);
      a = acc[h] = { p: 'x', f: r.firm };
    }
    delete a.gone;
    if (r.dayPnl) st.today[h] = [small(r.id) ? 1 : 0, r.dayPnl > 0 ? 1 : -1];
  });

  Object.keys(acc).forEach(h => {
    const a = acc[h]; if (seen[h]) return;
    if (a.gone){ if (dayNo(meta.built) - dayNo(a.gone) > KEEP_GONE_DAYS) delete acc[h]; return; }
    a.gone = meta.built.slice(0, 10);
    if (a.z || a.r || a.p === 'x') return;
    a.z = 1;
    if (based) return;
    a.u = 1; add(a.p === 'e' ? 'pass' : 'win', false);
    note(a.p === 'e' ? 'eval left the dashboard without a pass: blown' : 'funded account left the dashboard without a win: lost', a.f, h);
  });

  // the flip counts: the days of earlier trading days plus the ones seen today
  const s = todays(st);
  if (based) st.flipDone = { flip: [st.counts.flip[0] - s.flip[0], st.counts.flip[1] - s.flip[1]], flip25: [st.counts.flip25[0] - s.flip25[0], st.counts.flip25[1] - s.flip25[1]] };
  ['flip', 'flip25'].forEach(k => { st.counts[k] = [st.flipDone[k][0] + s[k][0], st.flipDone[k][1] + s[k][1]]; });
  if (st.log.length > LOG_LINES) st.log = st.log.slice(-LOG_LINES);
  if (st.marks.length > MARK_LINES) st.marks = st.marks.slice(-MARK_LINES);
  return st;
}

// one remembered account and one log line per line, so a change shows as a short diff
function dump(st){
  const rows = Object.keys(st.acc).map(h => '  ' + JSON.stringify(h) + ': ' + JSON.stringify(st.acc[h])).join(',\n');
  const head = ['v', 'at', 'built', 'day', 'counts', 'flipDone', 'base', 'today'].map(k => ' ' + JSON.stringify(k) + ': ' + JSON.stringify(st[k])).join(',\n');
  const lines = a => a.length ? '\n' + a.map(l => '  ' + JSON.stringify(l)).join(',\n') + '\n ' : '';
  return '{\n' + head + ',\n "marks": [' + lines(st.marks || []) + '],\n "acc": {' + (rows ? '\n' + rows + '\n ' : '') + '},\n "log": [' + lines(st.log) + ']\n}\n';
}
// everything in a counts file except how far it has read
function body(st){ const o = copy(st); delete o.at; delete o.built; return JSON.stringify(o); }

function git(dir, args){ return cp.execFileSync('git', ['-C', dir].concat(args), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
// the builds after one commit (all of them when none is given), oldest first
function builds(dir, after){
  return git(dir, ['log', '--reverse', '--format=%H %cI', after ? after + '..HEAD' : 'HEAD', '--', 'index.html']).trim().split('\n').filter(Boolean)
    .map(l => { const p = l.split(' '); return { sha: p[0], built: new Date(p[1]).toISOString() }; });
}
function page(dir, sha){ return git(dir, ['show', sha + ':index.html']); }
function reaches(dir, sha){ try { git(dir, ['merge-base', '--is-ancestor', sha, 'HEAD']); return true; } catch (e){ return false; } }

function main(){
  const dir = process.argv[2], dash = process.argv[3];
  if (!dir || !dash){ console.error('usage: node tools/track.js <folder> <clone of the dashboard repository>'); process.exit(2); }
  const cache = {}, shown = sha => cache[sha] || (cache[sha] = page(dash, sha));
  for (const k of FLEETS){
    const file = path.join(dir, k + '.json');
    let st = null, old = '', list;
    if (fs.existsSync(file)){
      try { old = fs.readFileSync(file, 'utf8'); st = JSON.parse(old); if (!st || st.v !== 2 || !st.counts || !st.acc || !st.at) throw new Error('not a counts file'); }
      catch (e){ console.log(k + ': saved counts not readable (' + e.message + '): left alone'); continue; }
    }
    if (st && reaches(dash, st.at)) list = builds(dash, st.at);
    else if (st){ list = builds(dash).slice(-1); console.log(k + ': the dashboard history no longer has the build read last: going on from its newest build'); }
    else {
      // first run: start at the newest build that carries the Lifetime table
      const all = builds(dash); let i = all.length - 1;
      for (; i >= 0; i--){ const snap = read(shown(all[i].sha), k); if (snap && snap.life) break; }
      if (i < 0){ console.log(k + ': no build with a Lifetime table to start from: nothing written'); continue; }
      list = all.slice(i);
    }
    const before = st ? body(st) : '';
    let unread = 0;
    for (const b of list){
      const snap = read(shown(b.sha), k);
      if (snap) st = step(st, snap, b); else unread++;
      if (st){ st.at = b.sha; st.built = b.built; }
    }
    if (!st){ console.log(k + ': nothing readable'); continue; }
    // how far it has read is saved with a change, or once enough builds have gone by
    const changed = body(st) !== before, out = dump(st);
    if (out !== old && (changed || list.length >= SAVE_EVERY)) fs.writeFileSync(file, out);
    console.log(k + ': ' + list.length + ' builds read' + (unread ? ' (' + unread + ' not readable)' : '') + ' | ' + KEYS.map(x => x + ' ' + st.counts[x][0] + '/' + st.counts[x][1]).join(', ') + (changed ? ' | saved' : ''));
  }
}
if (require.main === module) main();
module.exports = { read: read, step: step, dump: dump, text: text, money: money, key: key, small: small };
