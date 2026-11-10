'use strict';
// Counts real results for the Live rates on the roadmap page.
//
// Every run reads the fleet dashboard and compares it with what the run before saw. What happened in between is added
// to six counters per fleet: evals passed / failed, funded trades won / lost, flip days won / lost. The page turns them
// into its three Live rates. Nothing from before the first run is counted.
//
//   node tools/track.js <folder> [saved dashboard.html]      writes <folder>/g1.json and <folder>/v2.json
//
// How a result is recognised (the dashboard has one row per account, and hides an account once it is liquidated):
//   eval    passed  = its row says PASSED, or it leaves just as a new funded account of the same firm appears.
//           failed  = it leaves with no funded account in its place, and it was one stop from its floor.
//           An eval that leaves any other way (taken off by hand) is not counted.
//   funded  every new losing trade = a trade lost (the stop that liquidates it too); moving to the flips = the trade won.
//   flip    every new trading day of a 50K account = a flip day won (qualifying / target) or lost. 25K accounts are
//           left out, the page gives that size its own flip rate. The losing day that liquidates a flip is not seen.
// An account has to be missing on two runs in a row before it counts as gone, so a half-built dashboard changes nothing.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DASH = 'https://randompotato247.github.io/fleet-dashboard/';
const FLEETS = ['g1', 'v2'];
const KEYS = ['evalPass', 'evalFail', 'fundedWin', 'fundedLoss', 'flipWin', 'flipLoss'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', minus: '-' };

function entity(m, e){
  if (e[0] !== '#') return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  const cp = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
}
function text(html){ return String(html).replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity).replace(/−/g, '-').replace(/\s+/g, ' ').trim(); }
function money(s){ const m = /([+-]?)\$([\d,]+(?:\.\d+)?)/.exec(s || ''); return m ? (m[1] === '-' ? -1 : 1) * Number(m[2].replace(/,/g, '')) : null; }
function lastMoney(s){ const all = String(s || '').match(/[+-]?\$[\d,]+(?:\.\d+)?/g); return all ? money(all[all.length - 1]) : null; }
function mmdd(d){ return ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
// account numbers stay out of the saved file: a row is remembered by a short hash of its number
function key(id){ return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12); }
function small(id){ const m = /^LF[EF]0?(25|50|100|150)/i.exec(id) || /DFYSLX?(25|50|100|150)/i.exec(id); return !!m && +m[1] === 25; }
// "Topstep XFA", "Aqua funded" and "Tradeify Flex" are the funded accounts of Topstep, Aqua and Tradeify
function firmKey(s){ return String(s || '').toLowerCase().replace(/\b(xfa|funded|flex)\b/g, '').replace(/[^a-z]/g, ''); }

// one table of accounts: its rows, or null when it is not the table this script knows
function pane(sec, k, name){
  const a = sec.indexOf('id="p-' + k + '-' + name + '"'); if (a < 0) return null;
  const b = sec.indexOf('</table>', a); if (b < 0) return null;
  const rows = sec.slice(a, b).split(/<tr[\s>]/i).slice(1).map(tr => { const cells = []; tr.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (m, c) => { cells.push(text(c)); return ''; }); return cells; });
  const h = rows[0];
  if (!h || h.length < 6 || h[0] !== 'Account' || !/total/i.test(h[3]) || !/room/i.test(h[4]) || !/last trade/i.test(h[5])) return null;
  return rows.slice(1).filter(c => c.length >= 6 && c[0]).map(c => {
    const total = c[3], last = c[5], d = /^(\d\d-\d\d)\b/.exec(last), of = /of \$([\d,]+)/.exec(total);
    return { id: c[0], firm: firmKey(c[1]), passed: /PASSED/i.test(total), dead: /LIQUIDATED/i.test(total), retired: /RETIRED/i.test(total),
      pnl: money(total), target: of ? Number(of[1].replace(/,/g, '')) : null, room: money(c[4]),
      day: d ? d[1] : '', won: d ? lastMoney(last.slice(5)) : null, kind: last };
  });
}

// what the dashboard shows for one fleet right now, or null when its section cannot be trusted
function read(html, k){
  const a = html.indexOf('id="eng-' + k + '"'); if (a < 0) return null;
  let b = html.length;
  FLEETS.forEach(o => { const i = o === k ? -1 : html.indexOf('id="eng-' + o + '"', a + 1); if (i > a && i < b) b = i; });
  const f = html.indexOf('class="foot"', a); if (f > a && f < b) b = f;
  const sec = html.slice(a, b), snap = { day: '', recent: [] };
  for (const name of ['eval', 'funded', 'flip']){ const rows = pane(sec, k, name); if (!rows) return null; snap[name] = rows; }
  // a dashboard that is still being built must not read as "every account is gone"
  const tabs = /Evals ?(\d+) ?Fundeds ?(\d+) ?Flips ?(\d+)/.exec(text(sec));
  if (tabs && [snap.eval, snap.funded, snap.flip].some((rows, i) => +tabs[i + 1] > 0 && !rows.length)) return null;
  // the trading day and the calendar day before it: a trade dated one of them is from this session
  const day = /Trading day ([A-Za-z]{3}) (\d{1,2}) ([A-Za-z]{3})/.exec(text(html)), mon = day ? MONTHS.indexOf(day[3].toLowerCase()) : -1;
  if (day && mon >= 0){
    const t = Date.UTC(new Date().getUTCFullYear(), mon, +day[2]);
    snap.day = day[1] + ' ' + day[2] + ' ' + day[3];
    snap.recent = [mmdd(new Date(t)), mmdd(new Date(t - 864e5))];
  }
  return snap;
}

// One run: the counts and the remembered rows after seeing this snapshot.
// A remembered row: p = table (e eval, f funded, x flip), f = firm, t = date of its last trade, l = has a loss on it,
// g = where an eval stands (p one win from its target, f one stop from its floor, b both), z = its result is in
// (1 passed, 2 other), u = a passed eval's funded account has shown up, m = missing on the last run, w = left as a pass.
function step(prev, snap, since){
  const fresh = !(prev && prev.v === 1 && prev.counts && prev.acc);
  const st = fresh ? { v: 1, since: since || '', day: '', counts: {}, acc: {} } : JSON.parse(JSON.stringify(prev));
  KEYS.forEach(k => { st.counts[k] = Math.max(0, Math.round(Number(st.counts[k]) || 0)); });
  const acc = st.acc, seen = new Set(), born = {};
  const add = k => { if (!fresh) st.counts[k]++; };
  // funded accounts that are new on the dashboard, per firm: each one is an eval that passed
  if (!fresh) snap.funded.concat(snap.flip).forEach(r => { if (!acc[key(r.id)]) born[r.firm] = (born[r.firm] || 0) + 1; });

  snap.eval.forEach(r => {
    const h = key(r.id); seen.add(h);
    let a = acc[h]; if (!a || a.p !== 'e') a = acc[h] = { p: 'e' };
    a.f = r.firm; delete a.m; delete a.w;
    if (a.z) return;
    if (r.passed){ add('evalPass'); a.z = 1; delete a.g; return; }
    if (r.dead || r.retired){ if (r.dead) add('evalFail'); a.z = 2; delete a.g; return; }
    const T = r.target, nearPass = T > 0 && r.pnl !== null && T - r.pnl <= 0.55 * T, nearFail = T > 0 && r.room !== null && r.room <= 0.4 * T;
    if (nearPass || nearFail) a.g = nearPass && nearFail ? 'b' : nearPass ? 'p' : 'f'; else delete a.g;
  });

  snap.funded.forEach(r => {
    const h = key(r.id); seen.add(h);
    let a = acc[h]; const isNew = !a || a.p !== 'f';
    if (isNew) a = acc[h] = { p: 'f', t: '' };
    delete a.m;
    if (r.day && r.day !== a.t){
      // a losing trade not seen before; on a row that is new here, only when the trade is from this session
      if (r.won !== null && r.won < 0 && (!isNew || snap.recent.indexOf(r.day) >= 0)) add('fundedLoss');
      a.t = r.day;
    }
    if (r.dead || r.retired) a.z = 2;
    if (r.pnl !== null && r.pnl < 0) a.l = 1; else delete a.l;
  });

  snap.flip.forEach(r => {
    const h = key(r.id); seen.add(h);
    let a = acc[h];
    if (a && a.p === 'f'){ if (!a.z) add('fundedWin'); a = acc[h] = { p: 'x', t: r.day }; }      // reached profit: the trade that did it is no flip day
    else if (!a || a.p !== 'x') a = acc[h] = { p: 'x', t: r.day };
    else if (r.day && r.day !== a.t){
      if (!small(r.id) && r.won !== null){
        if (r.won > 0 && /qualifying|target/i.test(r.kind)) add('flipWin'); else if (r.won < 0) add('flipLoss');
      }
      a.t = r.day;
    }
    delete a.m;
    if (r.dead || r.retired) a.z = 2;
  });

  // the new funded accounts go to the evals that passed: first to one already seen as PASSED, then to one leaving right now
  // (one that could pass on its next trade before one that could not)
  const gone = Object.keys(acc).filter(h => !seen.has(h)), rank = { p: 0, b: 1, f: 3 };
  Object.keys(acc).forEach(h => { const a = acc[h]; if (a.p === 'e' && a.z === 1 && !a.u && born[a.f] > 0){ born[a.f]--; a.u = 1; } });
  gone.filter(h => acc[h].p === 'e' && !acc[h].z && !acc[h].m)
    .sort((x, y) => (rank[acc[x].g] === undefined ? 2 : rank[acc[x].g]) - (rank[acc[y].g] === undefined ? 2 : rank[acc[y].g]))
    .forEach(h => { const a = acc[h]; if (born[a.f] > 0){ born[a.f]--; a.w = 1; } });

  gone.forEach(h => {
    const a = acc[h];
    if (!a.m){ a.m = 1; return; }                              // missing once: wait for the next run
    if (!a.z){
      if (a.p === 'e'){ if (a.w) add('evalPass'); else if (a.g === 'f' || a.g === 'b') add('evalFail'); }
      else if (a.p === 'f' && a.l) add('fundedLoss');          // had a loss on it and never reached the flips: its second stop
    }
    delete acc[h];
  });
  if (snap.day) st.day = snap.day;
  return st;
}

// one remembered row per line, so a change shows as a short diff
function dump(st){
  const rows = Object.keys(st.acc).map(h => '  ' + JSON.stringify(h) + ': ' + JSON.stringify(st.acc[h])).join(',\n');
  return '{\n "v": 1,\n "since": ' + JSON.stringify(st.since) + ',\n "day": ' + JSON.stringify(st.day) + ',\n "counts": ' + JSON.stringify(st.counts) + ',\n "acc": {' + (rows ? '\n' + rows + '\n ' : '') + '}\n}\n';
}

async function main(){
  const dir = process.argv[2], saved = process.argv[3];
  if (!dir){ console.error('usage: node tools/track.js <folder> [saved dashboard.html]'); process.exit(2); }
  let html;
  try {
    if (saved) html = fs.readFileSync(saved, 'utf8');
    else { const res = await fetch(DASH + '?t=' + Date.now(), { cache: 'no-store' }); if (!res.ok) throw new Error('HTTP ' + res.status); html = await res.text(); }
  } catch (e){ console.log('dashboard not readable (' + e.message + '): nothing changed'); return; }
  const since = new Date().toISOString().slice(0, 10);
  for (const k of FLEETS){
    const file = path.join(dir, k + '.json');
    let prev = null, old = '';
    if (fs.existsSync(file)){
      try { old = fs.readFileSync(file, 'utf8'); prev = JSON.parse(old); if (!prev || prev.v !== 1 || !prev.counts || !prev.acc) throw new Error('not a counts file'); }
      catch (e){ console.log(k + ': saved counts not readable (' + e.message + '): left alone'); continue; }
    }
    const snap = read(html, k);
    if (!snap){ console.log(k + ': dashboard section not readable: nothing changed'); continue; }
    const next = step(prev, snap, since), out = dump(next);
    if (out !== old) fs.writeFileSync(file, out);
    console.log(k + ': ' + KEYS.map(x => x + ' ' + next.counts[x]).join(', ') + ' | ' + Object.keys(next.acc).length + ' accounts' + (out !== old ? ' | saved' : ''));
  }
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { read: read, step: step, dump: dump, text: text, money: money, key: key, small: small, firmKey: firmKey };
