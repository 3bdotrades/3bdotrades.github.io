'use strict';
// Keeps for good what people change on the page: the firms unticked in a fleet's view, each size's slots, and what is typed
// on the 5ers tab (its money, record, slots and accounts).
//
// The page sends every such edit to a public relay (ntfy.sh), and the relay forgets a message after 12 hours. This reads what
// the relay holds right now and writes the newest version of each part (g1, v2, 5ers) into shared.json, next to the counts on
// the "track" branch. A page that opens reads that file too, so an edit is still there once the relay has forgotten it.
// It runs with the counter (tools/track.js), every 10 minutes. No key and no sign-in anywhere: anyone with the page can
// change these, so everything read here is checked and cut to size before it is kept.
//
// Usage: node tools/share.js <folder>           (the relay topic can be set with the environment variable SHARE_TOPIC)
const fs = require('fs'), path = require('path');

const TOPIC = process.env.SHARE_TOPIC || 'funded-slots-roadmap-edits-7c41f9';
const RELAY = 'https://ntfy.sh/' + TOPIC + '/json?poll=1&since=all';
// (The Simulation tab's part, sim, went with the tab on 17 Nov 2026: it is no longer read or kept.)
// (5ers2: the 5ers tab's second profile, since 19 Nov 2026; the same numbers as 5ers, and it starts empty.)
const PARTS = ['g1', 'v2', '5ers', '5ers2'], KEY_RX = /^[a-z]{1,40}\|\d{1,4}$/, FIRM_RX = /^[a-z]{1,40}$/, SLOTS_MAX = 5;

// The 5ers tab's numbers, by the page's own rule (cleanFive in index.html), v 4 (FIVE_V): the slots of the 50K and of the 25K; five
// accounts a size ('' none, 'e' an eval, 'f' a funded account, 'p3:DATE' / 'p2:DATE' / 'p1:DATE' a funded win with three,
// two or one payouts still due, ':AMOUNT' after the day when its payouts are not the usual ones); and the journal, a line
// 'DATE KIND N AMOUNT' for everything done (DATE a day or '-' before the journal; KIND b50 / b25 evals bought, m paid for
// evals, s50 / s25 evals passed, x50 / x25 evals lost, w / l funded trades won / lost, p / h payouts in cash / in hub
// credits), at most J_MAX dated lines, the oldest beyond that folded into the '-' line of their kind. The tab started from
// scratch on 17 Nov 2026 (v 3) and again that evening with the owner's accounts and the 8 evals he holds (v 4, the owner's
// word): a part of v 3 or older is never read or kept again, and the tab opens with his state (J_SEED and ACC_SEED, as on
// the page). cr: the hub credits held (left out when none); fed: the time of the last result of his bot that is in the part
// (tools/five.js puts them in), left out when none.
// pre: the evals recorded as bought that the bot has not seen yet, 'DATE:SIZE' each, the newest 20 (left out when none).
const PRE_RX = /^\d{4}-\d\d-\d\d:(?:50|25)$/, PRE_MAX = 20;
const CR_MAX = 9999.99, FED_RX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/;
const cent2 = v => Math.round(v * 100) / 100;
const FIVE_V = 4, FIVE_SIZES = [{ k: '50', pay: 1158 }, { k: '25', pay: 579 }], FIVE_MAX = 5;
const ACC_RX = /^(?:e|f|p[123]:(\d{4}-\d\d-\d\d)(?::(\d{1,6}(?:\.\d\d?)?))?|E(?::(-?\d{1,5})(?::([0-5]))?)?|F(?::(-?\d{1,5})(?::([0-5])(?::([0-4]))?)?)?)$/;
const J_MAX = 100, J_RX = /^(\d{4}-\d\d-\d\d|-) (b50|b25|s50|s25|x50|x25|w|l|m|p|h) (\d{1,4}) (\d{1,7}(?:\.\d\d?)?)$/;
const J_ORDER = ['b25', 'b50', 'm', 's25', 's50', 'x25', 'x50', 'w', 'l', 'p', 'h'], J_COUNTED = ['b50', 'b25', 's50', 's25', 'x50', 'x25', 'w', 'l'];
const J_SEED = ['2026-11-17 b50 5 400', '2026-11-17 b25 3 141.6'];
const ACC_SEED = { '50': ['e', 'e', 'e', 'e', 'e'], '25': ['p1:2026-11-26:965', 'p3:2026-12-01:578', 'e', 'e', 'e'] };
function dateOf(s){
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(s)); if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return +m[1] >= 2020 && +m[1] <= 2100 && d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
}
function jLine(x){
  const m = typeof x === 'string' ? J_RX.exec(x) : null; if (!m) return null;
  const d = m[1], k = m[2], n = Number(m[3]), a = Math.round(Number(m[4]) * 100) / 100, buy = k.charAt(0) === 'b';
  if (d !== '-' && !dateOf(d)) return null;
  if (J_COUNTED.indexOf(k) >= 0 ? !(n >= 1) : n !== 0) return null;
  if (k === 'm' || k === 'p' || k === 'h' ? !(a > 0) : !buy && a !== 0) return null;
  return { d: d, k: k, n: n, a: a, s: d + ' ' + k + ' ' + n + ' ' + a };
}
function accClean(x, z){
  const m = typeof x === 'string' ? ACC_RX.exec(x) : null; if (!m) return '';
  if (!m[1]) return x;
  if (!dateOf(m[1])) return '';
  const amt = m[2] === undefined ? 0 : Math.round(Number(m[2]) * 100) / 100;
  if (m[2] !== undefined && !(amt > 0)) return '';
  return x.slice(0, 13) + (amt > 0 && amt !== z.pay ? ':' + amt : '');
}
function cleanFive(o, second){
  o = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  if (o.v !== FIVE_V) o = second ? { v: FIVE_V, acc: {}, j: [] } : { v: FIVE_V, acc: ACC_SEED, j: J_SEED };     // (from before v 4: nothing kept, the owner's state)
  const pre = {}, lines = [], p = { v: FIVE_V, cap: [], acc: {}, j: [] };
  const fold = l => { const q = pre[l.k] || (pre[l.k] = { n: 0, a: 0 }); q.n += l.n; q.a = Math.round((q.a + l.a) * 100) / 100; };
  (Array.isArray(o.j) ? o.j.slice(0, 2000) : []).forEach(x => { const l = jLine(x); if (l){ if (l.d === '-') fold(l); else lines.push(l); } });
  lines.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  while (lines.length > J_MAX) fold(lines.shift());
  J_ORDER.forEach(k => { const q = pre[k], l = q && jLine('- ' + k + ' ' + Math.min(9999, q.n) + ' ' + Math.min(9999999.99, q.a)); if (l) p.j.push(l.s); });
  lines.forEach(l => p.j.push(l.s));
  FIVE_SIZES.forEach((z, i) => {
    const cap = Array.isArray(o.cap) ? o.cap[i] : undefined, a = o.acc && Array.isArray(o.acc[z.k]) ? o.acc[z.k] : [];
    p.cap[i] = typeof cap === 'number' && cap >= 0 && cap <= FIVE_MAX ? Math.round(cap) : FIVE_MAX;
    p.acc[z.k] = [];
    for (let j = 0; j < FIVE_MAX; j++) p.acc[z.k].push(accClean(a[j], z));
  });
  if (typeof o.cr === 'number' && o.cr > 0 && o.cr <= CR_MAX && cent2(o.cr) > 0) p.cr = cent2(o.cr);
  if (typeof o.fed === 'string' && FED_RX.test(o.fed) && isFinite(Date.parse(o.fed))) p.fed = o.fed;
  const wait = (Array.isArray(o.pre) ? o.pre : []).filter(x => typeof x === 'string' && PRE_RX.test(x) && !!dateOf(x.slice(0, 10))).sort().slice(-PRE_MAX);
  if (wait.length) p.pre = wait;
  return p;
}

// Rows below the default 5, plus legacy firm defaults still waiting to be edited.
function cleanSlots(o){
  const p = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).slice(0, 40).forEach(k => { const v = o[k], n = Math.round(v); if ((KEY_RX.test(k) || FIRM_RX.test(k)) && typeof v === 'number' && n >= 0 && n < SLOTS_MAX) p[k] = n; });
  return p;
}
function cleanKeys(a){ const o = []; (Array.isArray(a) ? a : []).forEach(k => { if (typeof k === 'string' && KEY_RX.test(k) && o.indexOf(k) < 0 && o.length < 40) o.push(k); }); return o; }
// a version: n counts the edits of a part, t is when the last one was made, by is the browser that made it
function cleanVersion(o){
  if (!o || typeof o !== 'object') return null;
  const n = o.n;
  if (typeof n !== 'number' || !(n >= 1 && n < 1e12) || Math.floor(n) !== n) return null;
  if (typeof o.t !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.t) || typeof o.by !== 'string' || !/^[a-z0-9]{6,16}$/.test(o.by)) return null;
  return { n: n, t: o.t, by: o.by };
}
// is version a newer than version b?
function ahead(a, b){
  if (a && b && a.slotsV !== b.slotsV) return a.slotsV === 2;
  return !!a && (!b || (a.n !== b.n ? a.n > b.n : a.t !== b.t ? a.t > b.t : a.by > b.by));
}
// one part as it came from the relay or from the file, with nothing in it but what the page understands: [name, part] or null
function cleanPart(o, name){
  const p = cleanVersion(o), k = name || (o && o.k);
  if (!p || PARTS.indexOf(k) < 0) return null;
  if (k === '5ers' || k === '5ers2'){                                 // (a 5ers part of before v 4 is not taken)
    if (!o.five || typeof o.five !== 'object' || o.five.v !== FIVE_V) return null;
    p.five = cleanFive(o.five, k === '5ers2'); return [k, p];
  }
  if (o.slotsV === 2) p.slotsV = 2;
  p.skip = cleanKeys(o.skip);
  p.slots = cleanSlots(o.slots);
  return [k, p];
}
// what a kept file holds, checked
function readKept(text){
  const state = {}; let j = null;
  try { j = JSON.parse(text); } catch (e) { return state; }
  if (!j || j.v !== 1) return state;
  PARTS.forEach(k => { const c = cleanPart(j[k], k); if (c) state[k] = c[1]; });
  return state;
}
// the relay's answer (one message a line) worked into the parts kept so far: { state, changed: names of the parts replaced, seen }
function merge(state, text){
  const out = Object.assign({}, state), changed = []; let seen = 0;
  String(text).split('\n').forEach(line => {
    let c = null;
    try { const m = JSON.parse(line); if (m && m.event === 'message' && typeof m.message === 'string'){ seen++; c = cleanPart(JSON.parse(m.message)); } } catch (e) {}
    if (c && ahead(c[1], out[c[0]])){ out[c[0]] = c[1]; if (changed.indexOf(c[0]) < 0) changed.push(c[0]); }
  });
  return { state: out, changed: changed, seen: seen };
}
function dump(state){
  const o = { v: 1 };
  PARTS.forEach(k => { if (state[k]) o[k] = state[k]; });
  return JSON.stringify(o, null, 1) + '\n';
}

// everything the relay holds for the topic, one message a line (three tries: now and then a connection is not answered)
async function relayText(){
  let last;
  for (let i = 0; i < 3; i++){
    try {
      const r = await fetch(RELAY, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e){ last = e; await new Promise(done => setTimeout(done, 1500)); }
  }
  throw last;
}
// One pass over a folder; returns the line to print. The file is written when a part got a newer version, and when a file
// that reads as a kept file holds something that is no longer kept (a part of the Simulation tab, a 5ers part of before v 4,
// the owner's state of 17 Nov 2026 evening), so those leave it at the next pass. A file that cannot be read is replaced only once
// there is an edit to keep; a relay that does not answer leaves any file as it is. The first pass makes the file even with
// nothing shared yet, so that a page asking for it finds one.
async function pass(dir, read){
  const file = path.join(dir, 'shared.json');
  let old = null; try { old = fs.readFileSync(file, 'utf8'); } catch (e) {}
  let text;
  try { text = await (read || relayText)(); }
  catch (e){ return 'shared: the relay did not answer (' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 80) + '): left as it is'; }
  const got = merge(readKept(old === null ? '' : old), text), out = dump(got.state);
  let sound = false; try { const j = JSON.parse(old); sound = !!j && j.v === 1; } catch (e) {}
  if (old === null || (out !== old && (got.changed.length || sound))) fs.writeFileSync(file, out);
  return 'shared: ' + got.seen + ' on the relay' + (got.changed.length ? ' | kept ' + got.changed.join(', ') : '');
}
if (require.main === module){
  if (!process.argv[2]){ console.error('usage: node tools/share.js <folder>'); process.exit(2); }
  pass(process.argv[2]).then(line => console.log(line), e => console.log('shared: ' + String(e && e.message || e).slice(0, 120)));
}
module.exports = { relayText: relayText, jLine: jLine, cleanKeys: cleanKeys, cleanSlots: cleanSlots, cleanFive: cleanFive, cleanVersion: cleanVersion, ahead: ahead, cleanPart: cleanPart, readKept: readKept, merge: merge, dump: dump, pass: pass, TOPIC: TOPIC };
