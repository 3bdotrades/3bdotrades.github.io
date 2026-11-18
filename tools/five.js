'use strict';
// Puts the results of the owner's bot into the 5ers tab, so that he does not type them (the owner, 18 Nov 2026: "make the
// dashboard update live").
//
// The bot on his PC trades his the5ers accounts and writes what happens into its journal, a line a happening. This reads
// that file, never writes it, and takes from it only: a new eval account (an eval bought), and a finished trade's result
// (an eval passed or lost, a funded trade won or lost), each with its day and the account's size. Nothing else leaves the
// PC: no account number, no price, no name.
// What it took goes into the tab's shared part (5ers) as if typed there, through the same relay the page uses, on top of the
// newest version anybody has (tools/share.js keeps it afterwards):
//   an eval bought   an empty place of that size becomes an Eval; a journal line with what it cost by the owner's rule (its
//                    list price less the hub credits held, then 20% off); the credits used come off, the buy's are added
//   an eval passed   an Eval of that size becomes Funded; a journal line; the pass's hub credits are added
//   an eval lost     an Eval of that size becomes empty; a journal line
//   a funded win     a Funded account of that size has 3 payouts due, the first 14 days after the trade; a journal line
//   a funded loss    a Funded account of that size becomes empty; a journal line
// An eval he recorded himself before the bot saw it (the tab's "Bought" button, a Bought line, or a session typing it for him)
// waits in the part's `pre` list; a new eval account of that size seen up to PRE_DAYS days later takes one off the list
// and is not counted again. Entries older than that are dropped.
// A day's lines of one kind are one line (4 evals lost: "x50 4"). The part remembers the time of the last happening that is
// in it (fed), so nothing is put in twice, and if somebody's edit of the same minute wins over this one, the next pass puts
// the results in again. Payouts received and money paid otherwise stay typed by him.
// It waits while he is typing (an edit on the relay younger than QUIET_MS), and does nothing when the relay does not answer.
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
const SIZES = { '50': { list: 100, credit: 10 }, '25': { list: 59, credit: 5 } };
const DISC = 0.8, WAIT = 14, PAYS = 3, CR_MAX = 9999.99, PRE_DAYS = 3;
const PLAN_RX = /Daytrade(F?)-(25|50)K/;
const cent2 = v => Math.round(v * 100) / 100;

// the journal's happenings from `after` on (a time in ms), oldest first: { t, ms, day, what: 'b' | 's' | 'x' | 'w' | 'l', k: size }
function happenings(text, after, before){
  const plan = {}, seen = {}, out = [];
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
    if (o.kind !== 'account_new' && o.kind !== 'account_trade') return;
    if (!(ms > after && ms < before)) return;
    last = o.t;
    const p = plan[acc]; if (!p) return;
    let what = null;
    if (o.kind === 'account_new'){ if (!p.funded && !known) what = 'b'; }
    else if (o.in_progress !== true){
      const text = String(o.text || '');
      if (/^passed\b/.test(text) && !p.funded) what = 's';
      else if (/^lost\b/.test(text)) what = p.funded ? 'l' : 'x';
      else if (/^won\b/.test(text) && p.funded) what = 'w';
    }
    if (what) out.push({ t: o.t, day: o.t.slice(0, 10), what: what, k: p.k });
  });
  return { list: out, last: last };
}
function addDays(day, n){ const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
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
function words(c){
  const o = [];
  if (c.b) o.push(c.b + ' bought'); if (c.s) o.push(c.s + ' passed'); if (c.x) o.push(c.x + ' lost');
  if (c.w) o.push(c.w + ' funded won'); if (c.l) o.push(c.l + ' funded lost');
  if (c.known) o.push(c.known + ' bought already recorded');
  return o.join(', ');
}
// One pass; returns the line to print. o: { dry, creditsAs, read (the relay's text), send (posts a part), now }
async function pass(dir, journal, marker, o){
  o = o || {};
  let text;
  try { text = fs.readFileSync(journal, 'utf8'); } catch (e) { return 'five: no bot journal'; }
  let relay;
  try { relay = await (o.read || S.relayText)(); } catch (e) { return 'five: the relay did not answer: next pass'; }
  let old = ''; try { old = fs.readFileSync(path.join(dir, 'shared.json'), 'utf8'); } catch (e) {}
  const now = o.now || Date.now(), top = S.merge(S.readKept(old), relay).state['5ers'] || null;
  // an edit of the tab younger than QUIET_MS: he is typing, and what he types goes first
  let newest = 0;
  String(relay).split('\n').forEach(line => { try { const m = JSON.parse(line); if (m && m.event === 'message' && JSON.parse(m.message).k === '5ers' && m.time * 1000 > newest) newest = m.time * 1000; } catch (e) {} });
  if (now - newest < QUIET_MS && !o.dry) return 'five: the tab is being edited: next pass';
  let kept = ''; try { kept = fs.readFileSync(marker, 'utf8').trim(); } catch (e) {}
  const base = S.cleanFive(top ? top.five : null);
  // What waits for the bot, as this PC last saw it (a file next to the marker): a copy of the page from before 19 Nov 2026
  // that edits the part drops the list. An entry this PC saw, that is gone while its Bought line is still in the journal,
  // was dropped that way and is put back (a line he took out takes its entry with it, and stays out).
  const preFile = marker + '.pre', today = new Date(now).toISOString().slice(0, 10);
  let sawPre = []; try { sawPre = JSON.parse(fs.readFileSync(preFile, 'utf8')).filter(x => typeof x === 'string'); } catch (e) {}
  const times = (a, x) => a.filter(y => y === x).length, pre0 = (base.pre || []).slice();
  sawPre.filter((x, i) => sawPre.indexOf(x) === i).forEach(x => {
    const bought = base.j.some(l => { const q = S.jLine(l); return !!q && q.d === x.slice(0, 10) && q.k === 'b' + x.slice(11); });
    for (let miss = times(sawPre, x) - times(pre0, x); bought && miss > 0; miss--) pre0.push(x);
  });
  const withPre = S.cleanFive(Object.assign({}, base, { pre: pre0 }));
  const keepPre = five => { if (!o.dry) try { fs.writeFileSync(preFile, JSON.stringify((five.pre || []).filter(x => x.slice(0, 10) >= addDays(today, -PRE_DAYS - 1)))); } catch (e) {} };
  // Where to start: after the part's own mark. A part without one is his state from before the first results (they go in
  // from the start), unless the PC's mark says they went in and the part still has lines of those days: then an older copy
  // of the page edited it and dropped the mark, and the PC's mark stands in.
  const day0 = START.slice(0, 10), has = base.j.some(x => { const l = S.jLine(x); return !!l && l.d !== '-' && l.d >= day0 && /^[bsxwl]/.test(l.k); });
  const from = base.fed || (isFinite(Date.parse(kept)) && has ? kept : START);
  const got = happenings(text, Math.max(Date.parse(from), Date.parse(START) - 1), now - SETTLE_MS);
  if (!got.list.length && o.creditsAs === undefined){ keepPre(withPre); return 'five: nothing new'; }
  // more new evals at once than he ever buys (the bot's list of accounts made again): those are left to him, the results go in
  let list = got.list, more = '';
  if (list.filter(h => h.what === 'b').length > MAX_NEW){ list = list.filter(h => h.what !== 'b'); more = ' | more than ' + MAX_NEW + ' new evals at once: left to him'; }
  const done = apply(withPre, list, o.creditsAs === undefined);
  if (o.creditsAs !== undefined){ if (o.creditsAs > 0) done.five.cr = cent2(o.creditsAs); else delete done.five.cr; }
  if (got.last) done.five.fed = got.last;
  const part = { k: '5ers', n: (top ? top.n : 0) + 1, t: new Date(now).toISOString(), by: BY, five: S.cleanFive(done.five) };
  const body = JSON.stringify(part);
  if (JSON.stringify(part.five) === JSON.stringify(base)){ keepPre(withPre); return 'five: nothing new'; }
  if (Buffer.byteLength(body) > 4000) return 'five: the part is too long for the relay: left to him';
  if (o.dry) return 'five (dry): ' + (words(done.count) || 'no results') + ' | ' + body;
  // once more just before sending: nobody edited meanwhile
  let again; try { again = await (o.read || S.relayText)(); } catch (e) { return 'five: the relay did not answer: next pass'; }
  const top2 = S.merge(S.readKept(old), again).state['5ers'] || null;
  if (S.ahead(top2, top)) return 'five: the tab was edited meanwhile: next pass';
  try {
    if (o.send) await o.send(body);
    else { const r = await fetch(POST, { method: 'POST', body: body, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error('HTTP ' + r.status); }
  } catch (e) { return 'five: not sent (' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 60) + '): next pass'; }
  if (part.five.fed) try { fs.writeFileSync(marker, part.five.fed + '\n'); } catch (e) {}
  keepPre(part.five);
  return 'five: ' + (words(done.count) || (o.creditsAs !== undefined ? 'credits set' : 'no results')) + ' | sent n ' + part.n + more;
}
if (require.main === module){
  const a = process.argv.slice(2), i = a.indexOf('--credits-as'), cr = i >= 0 ? Number(a[i + 1]) : undefined;
  if (a.length < 3 || (i >= 0 && !(cr >= 0 && cr <= CR_MAX))){ console.error('usage: node five.js <folder> <journal.jsonl> <marker file> [--dry] [--credits-as N]'); process.exit(2); }
  pass(a[0], a[1], a[2], { dry: a.indexOf('--dry') >= 0, creditsAs: cr }).then(line => console.log(line), e => console.log('five: ' + String(e && e.message || e).slice(0, 120)));
}
module.exports = { happenings: happenings, apply: apply, pass: pass, addLine: addLine, START: START };
