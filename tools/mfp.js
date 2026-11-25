'use strict';
// The Perps tab's feed: the owner's My Funded Perpetuals accounts, counted, as mfp.json next to the live counts.
//
//   node mfp.js <track dir> <key file> <state file>            one pass (the PC's Roadmap_Counts task runs it)
//   node mfp.js <track dir> --from <accounts.json> <state file>  the same from a saved answer (the kit's tests)
//
// It asks MFP's developer API (docs.myfundedperpetuals.com, GET /v1/accounts, read only) for the accounts the key can see:
// each has an id, a stage (evaluation / funded), a status (active / passed / failed / closed) and a starting balance.
// What leaves this PC is counts only, by account size: evals open, funded open, and since the feed began how many evals
// were bought, passed and failed and how many funded accounts were issued and lost. No account id, name, balance or key.
// The key is the owner's own (Settings > API Keys on myfundedperpetuals.com, a READ key is enough), kept in a file on this
// PC that is never in a repository. No key file: one line and nothing else. The API cannot buy an account or request a
// payout, and shows no payouts. "Received" is read off the accounts instead: an approved payout is taken off the funded
// account's balance in full (their FAQ), so a funded account whose balance fell by its minimum payout (1% of its size) or
// more while its newest fill is still the same one (GET /v1/fills, one row) was paid that much; the owner's share is 80%.
// A payout and a new fill between two passes is not seen, so the number can run under, never over.
// The state file remembers every account id seen and its last stage and status, so an account MFP archives later is still
// counted as bought, and a result is counted once.
// Only accounts MFP names Elite are the plan's (the owner's old Select 10K is not): the bot's own rule. An account seen
// before this rule is counted again only once it is read with an Elite name.
const fs = require('fs'), path = require('path'), https = require('https');

const HOST = 'developers.myfundedperpetuals.com', V = 1, SIZES = [5000, 10000, 25000, 50000, 100000];
const SPLIT = 0.8, MIN_PAYOUT = 0.01;       // the owner's Elite accounts: 80% is his; the smallest payout is 1% of the size

function get(key, where){
  return new Promise(function(resolve, reject){
    const req = https.request({ host: HOST, path: where || '/v1/accounts', method: 'GET', timeout: where ? 8000 : 20000,
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'User-Agent': 'roadmap-feed' } }, function(res){
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function(c){ body += c; if (body.length > 4e6) req.destroy(new Error('answer too long')); });
      res.on('end', function(){
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e){ reject(new Error('not JSON')); }
      });
    });
    req.on('timeout', function(){ req.destroy(new Error('timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// the accounts of an answer, only the fields used, only well-formed ones
function clean(answer){
  const rows = answer && Array.isArray(answer.data) ? answer.data : null;
  if (!rows) throw new Error('no data list');
  const out = [];
  const elite = function(a){ return /elite/i.test(String(a.name || '') + ' ' + String(a.display_name || '')); };
  // MFP names the funded account of a passed Elite eval only "Funded 5K" (seen 25 Nov 2026): it is the plan's when an
  // Elite eval of its size has passed (the bot's own rule, mfp_bot.is_elite)
  const passed = {};
  rows.slice(0, 2000).forEach(function(a){ if (a && a.stage === 'evaluation' && a.status === 'passed' && elite(a)) passed[Math.round(Number(a.starting_balance))] = true; });
  rows.slice(0, 2000).forEach(function(a){
    if (!a || typeof a.id !== 'string' || !/^[\w.:|-]{1,80}$/.test(a.id)) return;
    if (a.stage !== 'evaluation' && a.stage !== 'funded') return;
    if (!elite(a) && !(a.stage === 'funded' && passed[Math.round(Number(a.starting_balance))])) return;      // another program: not the plan's
    if (['active', 'passed', 'failed', 'closed'].indexOf(a.status) < 0) return;
    const size = Math.round(Number(a.starting_balance));
    if (SIZES.indexOf(size) < 0) return;                       // a sandbox or prize account of another size is not part of the plan
    const bal = Number(a.balance);
    out.push({ id: a.id, stage: a.stage, status: a.status, size: size, balance: isFinite(bal) && Math.abs(bal) < 1e9 ? bal : null });
  });
  return out;
}

function zero(){ const o = {}; SIZES.forEach(function(s){ o[s] = 0; }); return o; }

// state: { v, seen: { id: [stage, status, size] } }. Returns the counts and the state to keep.
function count(accounts, state){
  const seen = state && state.v === V && state.seen && typeof state.seen === 'object' ? JSON.parse(JSON.stringify(state.seen)) : {};
  accounts.forEach(function(a){ seen[a.id] = [a.stage, a.status, a.size, 1]; });
  const c = { evals: zero(), funded: zero(), bought: zero(), passed: zero(), failed: zero(), issued: zero(), lost: zero() };
  const now = {};
  accounts.forEach(function(a){ now[a.id] = true; });
  Object.keys(seen).forEach(function(id){
    const r = seen[id], stage = r[0], status = r[1], size = r[2];
    if (SIZES.indexOf(size) < 0 || r[3] !== 1) return;
    if (stage === 'evaluation') {
      c.bought[size]++;
      if (status === 'passed') c.passed[size]++;
      if (status === 'failed') c.failed[size]++;
      if (status === 'active' && now[id]) c.evals[size]++;
    } else {
      c.issued[size]++;
      if (status === 'failed') c.lost[size]++;
      if (status === 'active' && now[id]) c.funded[size]++;
    }
  });
  return { counts: c, state: { v: V, seen: seen } };
}

// Payouts read off the funded accounts. fills: { id: its newest fill's id, '' for none }; an account missing there was not
// read this pass and keeps its last record. Returns { bal: { id: [balance, fill] }, out: { size: gross dollars paid out } }.
function payouts(accounts, fills, state){
  const ok = state && state.v === V;
  const bal = ok && state.bal && typeof state.bal === 'object' ? JSON.parse(JSON.stringify(state.bal)) : {};
  const out = zero();
  if (ok && state.out && typeof state.out === 'object') SIZES.forEach(function(s){ const v = Number(state.out[s]); if (isFinite(v) && v > 0) out[s] = v; });
  accounts.forEach(function(a){
    if (a.stage !== 'funded' || a.status !== 'active' || a.balance === null || typeof fills[a.id] !== 'string') return;
    const was = bal[a.id];
    if (Array.isArray(was) && typeof was[0] === 'number' && was[1] === fills[a.id]) {
      const drop = was[0] - a.balance;
      if (drop >= MIN_PAYOUT * a.size - 0.005) out[a.size] = Math.round((out[a.size] + drop) * 100) / 100;
    }
    bal[a.id] = [a.balance, fills[a.id]];
  });
  return { bal: bal, out: out };
}
function received(out){ const r = zero(); SIZES.forEach(function(s){ r[s] = Math.round(out[s] * SPLIT * 100) / 100; }); return r; }

function same(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

async function main(){
  const args = process.argv.slice(2), track = args[0];
  const from = args[1] === '--from' ? args[2] : null, keyFile = from ? null : args[1], stateFile = from ? args[3] : args[2];
  if (!track || !stateFile || (!from && !keyFile)) { console.log('mfp: usage: node mfp.js <track dir> <key file> <state file>'); process.exit(2); }
  let answer, key = '', fills = {};
  if (from) { answer = JSON.parse(fs.readFileSync(from, 'utf8')); if (answer && answer.fills && typeof answer.fills === 'object') fills = answer.fills; }
  else {
    try { key = fs.readFileSync(keyFile, 'utf8').trim(); } catch (e) {}
    if (!key) { console.log('mfp: no key file, nothing read'); return; }
    if (!/^fp_live_[\w-]{8,200}$/.test(key)) { console.log('mfp: the key file does not hold a live key (fp_live_...)'); return; }
    try { answer = await get(key); } catch (e){ console.log('mfp: not read: ' + String(e.message).slice(0, 80)); return; }
  }
  let accounts;
  try { accounts = clean(answer); } catch (e){ console.log('mfp: not understood: ' + e.message); return; }
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
  if (!from) {                                   // the newest fill of each open funded account, inside 25 seconds in all
    const t0 = Date.now();
    for (const a of accounts.filter(function(x){ return x.stage === 'funded' && x.status === 'active'; }).slice(0, 40)) {
      if (Date.now() - t0 > 25000) break;
      try {
        const page = await get(key, '/v1/fills?account_id=' + encodeURIComponent(a.id) + '&limit=1');
        const row = page && Array.isArray(page.data) ? page.data[0] : null;
        if (page && Array.isArray(page.data)) fills[a.id] = row && typeof row.id === 'string' ? row.id.slice(0, 120) : '';
      } catch (e) {}
    }
  }
  const r = count(accounts, state), pay = payouts(accounts, fills, state);
  r.counts.received = received(pay.out);
  r.state.bal = pay.bal; r.state.out = pay.out;
  fs.writeFileSync(stateFile, JSON.stringify(r.state));
  const file = path.join(track, 'mfp.json');
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  if (old && old.v === V && same(old.counts, r.counts)) { console.log('mfp: no change (' + accounts.length + ' accounts)'); return; }
  fs.writeFileSync(file, JSON.stringify({ v: V, at: new Date().toISOString().slice(0, 19) + 'Z', counts: r.counts }) + '\n');
  const sum = function(o){ return SIZES.reduce(function(t, s){ return t + o[s]; }, 0); };
  console.log('mfp: ' + sum(r.counts.evals) + ' evals open, ' + sum(r.counts.funded) + ' funded open, ' + sum(r.counts.bought) + ' bought, received $' + sum(r.counts.received).toFixed(2));
}

if (require.main === module) main().catch(function(e){ console.log('mfp: failed: ' + String(e && e.message).slice(0, 100)); });
module.exports = { clean: clean, count: count, payouts: payouts, received: received, SIZES: SIZES, V: V };
