'use strict';
// Keeps for good what people change on the page: the firms unticked in a fleet's view, and the Simulation tab's set-up.
//
// The page sends every such edit to a public relay (ntfy.sh), and the relay forgets a message after 12 hours. This reads what
// the relay holds right now and writes the newest version of each part (g1, v2, sim) into shared.json, next to the counts on
// the "track" branch. A page that opens reads that file too, so an edit is still there once the relay has forgotten it.
// It runs with the counter (tools/track.js), every 10 minutes. No key and no sign-in anywhere: anyone with the page can
// change these, so everything read here is checked and cut to size before it is kept.
//
// Usage: node tools/share.js <folder>           (the relay topic can be set with the environment variable SHARE_TOPIC)
const fs = require('fs'), path = require('path');

const TOPIC = process.env.SHARE_TOPIC || 'funded-slots-roadmap-edits-7c41f9';
const RELAY = 'https://ntfy.sh/' + TOPIC + '/json?poll=1&since=all';
const PARTS = ['g1', 'v2', 'sim'], BASES = ['chance', 'g1', 'v2'], KEY_RX = /^[a-z]{1,40}\|\d{1,4}$/;

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
function ahead(a, b){ return !!a && (!b || (a.n !== b.n ? a.n > b.n : a.t !== b.t ? a.t > b.t : a.by > b.by)); }
// one part as it came from the relay or from the file, with nothing in it but what the page understands: [name, part] or null
function cleanPart(o, name){
  const p = cleanVersion(o), k = name || (o && o.k);
  if (!p || PARTS.indexOf(k) < 0) return null;
  if (k === 'sim'){
    p.base = BASES.indexOf(o.base) >= 0 ? o.base : 'chance';
    p.days = typeof o.days === 'number' && o.days >= 5 && o.days <= 364 ? Math.round(o.days) : 84;
    p.evals = {};
    if (o.evals && typeof o.evals === 'object' && !Array.isArray(o.evals)) Object.keys(o.evals).slice(0, 40).forEach(x => { const v = o.evals[x]; if (KEY_RX.test(x) && typeof v === 'number' && v >= 0) p.evals[x] = Math.min(500, Math.round(v)); });
    p.off = cleanKeys(o.off);
  } else p.skip = cleanKeys(o.skip);
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
// One pass over a folder; returns the line to print. The file is written when a part got a newer version, so a relay that is
// empty or does not answer leaves it as it is. The first pass makes the file even with nothing shared yet, so that a page
// asking for it finds one.
async function pass(dir, read){
  const file = path.join(dir, 'shared.json');
  let old = null; try { old = fs.readFileSync(file, 'utf8'); } catch (e) {}
  let text;
  try { text = await (read || relayText)(); }
  catch (e){ return 'shared: the relay did not answer (' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 80) + '): left as it is'; }
  const got = merge(readKept(old === null ? '' : old), text), out = dump(got.state);
  if (old === null || (got.changed.length && out !== old)) fs.writeFileSync(file, out);
  return 'shared: ' + got.seen + ' on the relay' + (got.changed.length ? ' | kept ' + got.changed.join(', ') : '');
}
if (require.main === module){
  if (!process.argv[2]){ console.error('usage: node tools/share.js <folder>'); process.exit(2); }
  pass(process.argv[2]).then(line => console.log(line), e => console.log('shared: ' + String(e && e.message || e).slice(0, 120)));
}
module.exports = { cleanKeys: cleanKeys, cleanVersion: cleanVersion, ahead: ahead, cleanPart: cleanPart, readKept: readKept, merge: merge, dump: dump, pass: pass, TOPIC: TOPIC };
