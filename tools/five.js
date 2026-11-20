'use strict';
// Puts the results of the owner's bot into the 5ers tab, so that he does not type them (the owner, 18 Nov 2026: "make the
// dashboard update live"; 20 Nov 2026: "Accounts need this to read blackarrow ... and updated live why i buy or blown or wait
// payout etc..", "and after payouts it change them to funded or decrease the 3 payouts to 2 or 1 etc..").
//
// The bot on his PC trades his the5ers accounts in BlackArrow and writes what happens into its journal, a line a happening.
// This reads that file, never writes it, and takes from it only: a new eval account (an eval bought), a finished trade's
// result (an eval passed or lost, a funded trade won or lost), and an account BlackArrow's log shows blocked outside a trade
// of the bot's (blown), each with its day and the account's size. Nothing else leaves the PC: no account number, no price,
// no name.
// What it took goes into the tab's shared part (5ers, Profile 1) as if typed there, through the same relay the page uses, on
// top of the newest version anybody has (tools/share.js keeps it afterwards):
//   an eval bought   an empty place of that size becomes an Eval; a journal line with what it cost by the owner's rule (its
//                    list price less the hub credits held, then 20% off); the credits used come off, the buy's are added
//   an eval passed   an Eval of that size becomes Funded; a journal line; the pass's hub credits are added
//   an eval lost     an Eval of that size becomes empty; a journal line (blown in BlackArrow outside a trade: the same)
//   a funded win     a Funded account of that size has 3 payouts due, the first 14 days after the trade; a journal line
//   a funded loss    a Funded account of that size becomes empty; a journal line (blown in BlackArrow: the same)
// A blown account counts only once, and only one bought since the record's start (18 Nov 2026), so that an old account of
// his that BlackArrow reports does not empty a place of another. The tab's places carry no account numbers: an account he
// cleared by hand that the bot still trades has its later result put on another place of its size.
// An eval he recorded himself before the bot saw it (the tab's "Bought" button, a Bought line, or a session typing it for him)
// waits in the part's `pre` list; a new eval account of that size seen up to PRE_DAYS days later takes one off the list
// and is not counted again. Entries older than that are dropped. PRE_DAYS was 3 until 20 Nov 2026, when two evals he bought
// waited while BlackArrow stayed closed (the bot sees an account only once it is added there): seen after 3 days, they
// would have been priced again and given a second place each. An eval recorded by hand that BlackArrow never shows would
// now cover a real purchase of its size within those 30 days instead (taken off the list by a session when that is known).
// Payouts that have come, on both profiles (5ers and 5ers2; the owner, in the dialog: "Yes, add it"): the day after a
// payout's day it goes into Received (a journal line 'DAY p 0 AMOUNT', in cash) and its account steps down, 3 payouts due -> 2
// (the next one 14 days later) -> 1 -> Funded, which trades again: a funded account goes on trading after its third payout.
// A PC that was off catches up at its next pass. "The day" is this PC's own date (Cairo).
// A day's lines of one kind are one line (4 evals lost: "x50 4"). The part remembers the time of the last happening that is
// in it (fed), so nothing is put in twice, and if somebody's edit of the same minute wins over this one, the next pass puts
// the results in again.
// It waits while a profile is being edited (an edit on the relay younger than QUIET_MS), and does nothing when the relay
// does not answer.
//
// Usage: node five.js <folder with shared.json> <the bot's journal.jsonl> <marker file> [--dry] [--credits-as N]
//   --dry            prints the part it would send, sends nothing
//   --credits-as N   this pass does not move the hub credits and leaves them at N (the owner gave his balance himself)
// It runs with the counter on the owner's PC, before tools/share.js, which it needs next to it.
const fs = require('fs'), path = require('path');
const S = require('./share.js');

const POST = 'https://ntfy.sh/' + S.TOPIC, BY = 'pcfeed01', QUIET_MS = 90 * 1000, SETTLE_MS = 5000, MAX_NEW = 10;
// his record counts from 18 Nov 2026 (his word of 17 Nov: "my record start from zero from tommrow"); nothing older is taken
const START = '2026-11-18T00:00:00.000+02:00';
const SIZES = { '50': { list: 100, credit: 10, pay: 1158 }, '25': { list: 59, credit: 5, pay: 579 } };
const DISC = 0.8, WAIT = 14, PAYS = 3, CR_MAX = 9999.99, PRE_DAYS = 30;
const PLAN_RX = /Daytrade(F?)-(25|50)K/, PAY_RX = /^p([123]):(\d{4}-\d\d-\d\d)(?::(\d+(?:\.\d+)?))?$/;
const cent2 = v => Math.round(v * 100) / 100;

// the journal's happenings from `after` on (a time in ms), oldest first: { t, ms, day, what: 'b' | 's' | 'x' | 'w' | 'l', k: size }
function happenings(text, after, before){
  const plan = {}, seen = {}, ended = {}, bought = {}, out = [], startMs = Date.parse(START);
  let last = null;
  String(text).split('\n').forEach(line => {
    if (line.indexOf('"account') < 0 && line.indexOf('"armed"') < 0) return;
    let o = null; try { o = JSON.parse(line); } catch (e) { return; }
    if (!o || typeof o.t !== 'string' || typeof o.account !== 'string') return;
    const ms = Date.parse(o.t), acc = o.account;
    if (!isFinite(ms)) return;
    const m = PLAN_RX.exec(String(o.kind === 'armed' ? o.plan : o.kind === 'account_new' ? o.text : ''));
    if (m) plan[acc] = { funded: m[1] === 'F', k: m[2] };
    const known = seen[acc]; seen[acc] = true;
    if (o.kind !== 'account_new' && o.kind !== 'account_trade' && o.kind !== 'account_blocked') return;
    const p = plan[acc];
    let what = null;
    if (o.kind === 'account_new'){
      if (ms > startMs) bought[acc] = true;
      if (p && !p.funded && !known) what = 'b';
    }
    else if (o.kind === 'account_trade'){
      if (o.in_progress !== true && !ended[acc]){
        const said = String(o.text || '');
        if (/^passed\b/.test(said) && p && !p.funded){ what = 's'; ended[acc] = true; }
        else if (/^lost\b/.test(said)){ if (p) what = p.funded ? 'l' : 'x'; ended[acc] = true; }
        else if (/^won\b/.test(said) && p && p.funded) what = 'w';
      }
    }
    else if (!ended[acc]){                      // blocked in BlackArrow, outside a trade of the bot's: blown, once
      ended[acc] = true;
      if (p && bought[acc]) what = p.funded ? 'l' : 'x';
    }
    if (!(ms > after && ms < before)) return;
    last = o.t;
    if (what) out.push({ t: o.t, day: o.t.slice(0, 10), what: what, k: p.k });
  });
  return { list: out, last: last };
}
function addDays(day, n){ const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// this PC's own date (Cairo), 'YYYY-MM-DD'
function localDay(ms){ const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// a journal line of that day and kind: added to the one that is there, or a new one
function addLine(j, day, kind, n, a){
  for (let i = 0; i < j.length; i++){
    const l = S.jLine(j[i]);
    if (l && l.d === day && l.k === kind){ j[i] = day + ' ' + kind + ' ' + (l.n + n) + ' ' + cent2(l.a + a); return; }
  }
  j.push(day + ' ' + kind + ' ' + n + ' ' + cent2(a));
}
function swap(list, from, to){ const i = list.indexOf(from); if (i >= 0) list[i] = to; return i >= 0; }
// the part's numbers with the happenings in; credits: false leaves the hub credits as they are
function apply(five, list, credits){
  const f = S.cleanFive(five), count = { b: 0, s: 0, x: 0, w: 0, l: 0, known: 0 };
  let cr = typeof f.cr === 'number' ? f.cr : 0, pre = (f.pre || []).slice();
  list.forEach(h => {
    const z = SIZES[h.k], acc = f.acc[h.k];
    if (h.what === 'b'){
      // one he recorded himself, up to PRE_DAYS days before the bot saw it: that is this one
      const at = pre.findIndex(x => x.slice(11) === h.k && x.slice(0, 10) <= h.day && x.slice(0, 10) >= addDays(h.day, -PRE_DAYS));
      if (at >= 0){ pre.splice(at, 1); count.known++; return; }
    }
    count[h.what]++;
    if (h.what === 'b'){
      const used = credits ? Math.min(cr, z.list) : 0;
      addLine(f.j, h.day, 'b' + h.k, 1, DISC * (z.list - used));
      if (credits) cr = cent2(cr - used + z.credit);
      swap(acc, '', 'e');
    }
    else if (h.what === 's'){ addLine(f.j, h.day, 's' + h.k, 1, 0); if (credits) cr = cent2(cr + z.credit); swap(acc, 'e', 'f'); }
    else if (h.what === 'x'){ addLine(f.j, h.day, 'x' + h.k, 1, 0); swap(acc, 'e', ''); }
    else if (h.what === 'w'){ addLine(f.j, h.day, 'w', 1, 0); swap(acc, 'f', 'p' + PAYS + ':' + addDays(h.day, WAIT)); }
    else if (h.what === 'l'){ addLine(f.j, h.day, 'l', 1, 0); swap(acc, 'f', ''); }
  });
  if (cr > 0) f.cr = Math.min(CR_MAX, cr); else delete f.cr;
  if (list.length){ const last = list[list.length - 1].day; pre = pre.filter(x => x.slice(0, 10) >= addDays(last, -PRE_DAYS)); }
  if (pre.length) f.pre = pre; else delete f.pre;
  return { five: f, count: count };
}
// The payouts whose day is before `today`: each into Received on its day, its account a step down (see the top).
// { five, came: [{ day, k, a }] }
function payoutsCome(five, today){
  const f = S.cleanFive(five), came = [];
  Object.keys(SIZES).forEach(k => {
    f.acc[k] = f.acc[k].map(x => {
      let m = PAY_RX.exec(x);
      while (m && m[2] < today){
        const amt = m[3] !== undefined ? Number(m[3]) : SIZES[k].pay, left = +m[1] - 1;
        came.push({ day: m[2], k: k, a: amt });
        addLine(f.j, m[2], 'p', 0, amt);
        x = left > 0 ? 'p' + left + ':' + addDays(m[2], WAIT) + (m[3] !== undefined ? ':' + m[3] : '') : 'f';
        m = PAY_RX.exec(x);
      }
      return x;
    });
  });
  return { five: S.cleanFive(f), came: came };
}
function words(c){
  const o = [];
  if (c.b) o.push(c.b + ' bought'); if (c.s) o.push(c.s + ' passed'); if (c.x) o.push(c.x + ' lost');
  if (c.w) o.push(c.w + ' funded won'); if (c.l) o.push(c.l + ' funded lost');
  if (c.known) o.push(c.known + ' bought already recorded');
  return o.join(', ');
}
function cameWords(came){ return came.length ? came.length + ' payout' + (came.length > 1 ? 's' : '') + ' came (' + came.map(c => '$' + c.a).join(' + ') + ')' : ''; }
// the time of a profile's newest edit on the relay (0: none)
function newestEdit(relay, k){
  let newest = 0;
  String(relay).split('\n').forEach(line => { try { const m = JSON.parse(line); if (m && m.event === 'message' && JSON.parse(m.message).k === k && m.time * 1000 > newest) newest = m.time * 1000; } catch (e) {} });
  return newest;
}
// a part sent, once more checked just before: nobody edited that profile meanwhile. '' when sent, else why not.
async function send(o, old, k, top, body){
  let again; try { again = await (o.read || S.relayText)(); } catch (e) { return 'the relay did not answer: next pass'; }
  const top2 = S.merge(S.readKept(old), again).state[k] || null;
  if (S.ahead(top2, top)) return 'the tab was edited meanwhile: next pass';
  try {
    if (o.send) await o.send(body);
    else { const r = await fetch(POST, { method: 'POST', body: body, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error('HTTP ' + r.status); }
  } catch (e) { return 'not sent (' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 60) + '): next pass'; }
  return '';
}
// One pass; returns the line to print. o: { dry, creditsAs, read (the relay's text), send (posts a part), now, today }
async function pass(dir, journal, marker, o){
  o = o || {};
  let text;
  try { text = fs.readFileSync(journal, 'utf8'); } catch (e) { return 'five: no bot journal'; }
  let relay;
  try { relay = await (o.read || S.relayText)(); } catch (e) { return 'five: the relay did not answer: next pass'; }
  let old = ''; try { old = fs.readFileSync(path.join(dir, 'shared.json'), 'utf8'); } catch (e) {}
  const now = o.now || Date.now(), today = o.today || localDay(now), state = S.merge(S.readKept(old), relay).state;
  const one = await profile1(o, text, relay, old, state, marker, now, today);
  const two = await profile2(o, relay, old, state, now, today);
  return one + (two ? ' ; ' + two : '');
}
async function profile1(o, text, relay, old, state, marker, now, today){
  const top = state['5ers'] || null;
  // an edit of the tab younger than QUIET_MS: he is typing, and what he types goes first
  if (now - newestEdit(relay, '5ers') < QUIET_MS && !o.dry) return 'five: the tab is being edited: next pass';
  let kept = ''; try { kept = fs.readFileSync(marker, 'utf8').trim(); } catch (e) {}
  const base = S.cleanFive(top ? top.five : null);
  // What waits for the bot, as this PC last saw it (a file next to the marker): a copy of the page from before 19 Nov 2026
  // that edits the part drops the list. An entry this PC saw, that is gone while its Bought line is still in the journal,
  // was dropped that way and is put back (a line he took out takes its entry with it, and stays out).
  const preFile = marker + '.pre', utcDay = new Date(now).toISOString().slice(0, 10);
  let sawPre = []; try { sawPre = JSON.parse(fs.readFileSync(preFile, 'utf8')).filter(x => typeof x === 'string'); } catch (e) {}
  const times = (a, x) => a.filter(y => y === x).length, pre0 = (base.pre || []).slice();
  sawPre.filter((x, i) => sawPre.indexOf(x) === i).forEach(x => {
    const bought = base.j.some(l => { const q = S.jLine(l); return !!q && q.d === x.slice(0, 10) && q.k === 'b' + x.slice(11); });
    for (let miss = times(sawPre, x) - times(pre0, x); bought && miss > 0; miss--) pre0.push(x);
  });
  const withPre = S.cleanFive(Object.assign({}, base, { pre: pre0 }));
  const keepPre = five => { if (!o.dry) try { fs.writeFileSync(preFile, JSON.stringify((five.pre || []).filter(x => x.slice(0, 10) >= addDays(utcDay, -PRE_DAYS - 1)))); } catch (e) {} };
  // Where to start: after the part's own mark. A part without one is his state from before the first results (they go in
  // from the start), unless the PC's mark says they went in and the part still has lines of those days: then an older copy
  // of the page edited it and dropped the mark, and the PC's mark stands in.
  const day0 = START.slice(0, 10), has = base.j.some(x => { const l = S.jLine(x); return !!l && l.d !== '-' && l.d >= day0 && /^[bsxwl]/.test(l.k); });
  const from = base.fed || (isFinite(Date.parse(kept)) && has ? kept : START);
  const got = happenings(text, Math.max(Date.parse(from), Date.parse(START) - 1), now - SETTLE_MS);
  // more new evals at once than he ever buys (the bot's list of accounts made again): those are left to him, the results go in
  let list = got.list, more = '';
  if (list.filter(h => h.what === 'b').length > MAX_NEW){ list = list.filter(h => h.what !== 'b'); more = ' | more than ' + MAX_NEW + ' new evals at once: left to him'; }
  const done = apply(withPre, list, o.creditsAs === undefined);
  if (o.creditsAs !== undefined){ if (o.creditsAs > 0) done.five.cr = cent2(o.creditsAs); else delete done.five.cr; }
  if (got.last && got.list.length) done.five.fed = got.last;
  const paid = payoutsCome(done.five, today);
  if (!got.list.length && !paid.came.length && o.creditsAs === undefined){ keepPre(withPre); return 'five: nothing new'; }
  const part = { k: '5ers', n: (top ? top.n : 0) + 1, t: new Date(now).toISOString(), by: BY, five: S.cleanFive(paid.five) };
  const body = JSON.stringify(part), said = [words(done.count), cameWords(paid.came)].filter(Boolean).join(', ');
  if (JSON.stringify(part.five) === JSON.stringify(base)){ keepPre(withPre); return 'five: nothing new'; }
  if (Buffer.byteLength(body) > 4000) return 'five: the part is too long for the relay: left to him';
  if (o.dry) return 'five (dry): ' + (said || 'no results') + ' | ' + body;
  const why = await send(o, old, '5ers', top, body);
  if (why) return 'five: ' + why;
  if (part.five.fed) try { fs.writeFileSync(marker, part.five.fed + '\n'); } catch (e) {}
  keepPre(part.five);
  return 'five: ' + (said || (o.creditsAs !== undefined ? 'credits set' : 'no results')) + ' | sent n ' + part.n + more;
}
// Profile 2 (5ers2) has no bot of its own here: only its payouts that have come step it on
async function profile2(o, relay, old, state, now, today){
  const top = state['5ers2'] || null; if (!top) return '';
  if (now - newestEdit(relay, '5ers2') < QUIET_MS && !o.dry) return '';
  const base = S.cleanFive(top.five, true), paid = payoutsCome(base, today);
  if (!paid.came.length) return '';
  const part = { k: '5ers2', n: top.n + 1, t: new Date(now).toISOString(), by: BY, five: S.cleanFive(paid.five, true) };
  const body = JSON.stringify(part);
  if (Buffer.byteLength(body) > 4000) return 'five2: the part is too long for the relay: left to him';
  if (o.dry) return 'five2 (dry): ' + cameWords(paid.came) + ' | ' + body;
  const why = await send(o, old, '5ers2', top, body);
  return 'five2: ' + (why || cameWords(paid.came) + ' | sent n ' + part.n);
}
if (require.main === module){
  const a = process.argv.slice(2), i = a.indexOf('--credits-as'), cr = i >= 0 ? Number(a[i + 1]) : undefined;
  if (a.length < 3 || (i >= 0 && !(cr >= 0 && cr <= CR_MAX))){ console.error('usage: node five.js <folder> <journal.jsonl> <marker file> [--dry] [--credits-as N]'); process.exit(2); }
  pass(a[0], a[1], a[2], { dry: a.indexOf('--dry') >= 0, creditsAs: cr }).then(line => console.log(line), e => console.log('five: ' + String(e && e.message || e).slice(0, 120)));
}
module.exports = { happenings: happenings, apply: apply, payoutsCome: payoutsCome, pass: pass, addLine: addLine, localDay: localDay, START: START };
