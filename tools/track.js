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
// unread = the time of the first build of the ones it could not read since the last one it read (none while it reads them):
// the page says the rates are not being counted when that lasts (from 16 Nov 2026 21:56 UTC to 20 Nov the dashboard's footer
// had no trading day, every build was not readable and the rates stood still with no word of it).
// cash = the fleet's real cash by day, for the page's Cash by week: days = for each New York date [received, spent] on it.
// A payout or a buy the dashboard lists with its date (the "Latest" lists of its Cash box) is booked on that date; a rise of
// "Received" or "Spent" that no listed line explains is booked on the day of the build that first shows it (or, when the
// full list is there and does not have it, on the list's oldest date: it is older than that). open = the first day read:
// what it carries is everything from before. rest = the part of each day that came from the totals and not from a dated
// line (a dated line that turns up later takes its amount back out of it). seen = the dated lines booked, by a hash.
// The cash is kept only in a file that has it: `node tools/track.js <folder> <clone> --cash` reads every build once and
// writes it (one time, by hand).
// open = the most evals the fleet had open at once (rows of the eval table that are not passed and not liquidated), for each
// New York date of the last KEEP_OPEN_DAYS: days = { date: the highest number a build of that date showed }. The page's plan
// keeps that many evals trading (its seats). firms = { date: { firm as the dashboard names it: its open evals } } on the build
// that showed that day's highest number: the page's plan shares its seats among the firms the way the fleet does.
// avg = { date: [the open evals of every build of that date added up, the builds] }: the day's average, which is what the
// page's seats are since 26 Nov 2026 (the highs ran about a sixth above what the fleet holds).
// buys = { date: { firm: the evals first shown that date } }: what the fleet bought, which the page's firm mix follows. Kept only in a file that has it: `--open` in place of `--cash` writes it once.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');

const FLEETS = ['g1', 'v2'], KEYS = ['pass', 'win', 'flip', 'flip25'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', minus: '-' };
const OTHERS = ['rm'], FULL_LIST = 7, KEEP_SEEN_DAYS = 120, KEEP_OPEN_DAYS = 40, KEEP_BOUGHT_DAYS = 14, KEEP_PAY_DAYS = 30, PAY_KEEP = 12;
const KEEP_GONE_DAYS = 10, LOG_LINES = 400, MARK_LINES = 400, SAVE_EVERY = 200;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
      dayPnl: money(c[2]), pnl: money(total), target: of ? int(of[1]) : null, room: money(c[4]), day: d ? d[1] : '',
      days: (x => x ? [int(x[1]), int(x[2])] : null)(/(\d+)\s*\/\s*(\d+)\s*days/i.exec(total)), req: /payout requested/i.test(total) };
  });
}

// a fleet's part of a build ('' when it has none)
function section(html, k){
  const a = html.indexOf('id="eng-' + k + '"'); if (a < 0) return '';
  let b = html.length;
  FLEETS.concat(OTHERS).forEach(o => { const i = o === k ? -1 : html.indexOf('id="eng-' + o + '"', a + 1); if (i > a && i < b) b = i; });
  const f = html.indexOf('class="foot"', a); if (f > a && f < b) b = f;
  return html.slice(a, b);
}
// New York's date at a moment, 'YYYY-MM-DD'
function nyDate(iso){ const p = nyAt(Date.parse(iso)); return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2); }
// The fleet's Cash box in a build: { inn, out, pays, buys } (the two totals, and the dated lines of the two "Latest" lists as
// { d: 'YYYY-MM-DD', h: a hash of the line, amt }), or null when the two totals are not there.
function cashOf(html, k, built){
  const sec = section(html, k), day = nyDate(built), o = { inn: null, out: null, pays: [], buys: [] };
  [['Received', 'inn', 'pays'], ['Spent', 'out', 'buys']].forEach(x => {
    const a = sec.indexOf('<th>' + x[0] + '</th>'); if (a < 0) return;
    const e = sec.indexOf('</tr>', a), row = sec.slice(a, e < 0 ? sec.length : e), m = /<td[^>]*>(?:\s*<span[^>]*>)?\s*[-\u2212]?\$([\d,]+(?:\.\d+)?)/.exec(row);
    if (!m) return;
    o[x[1]] = Number(m[1].replace(/,/g, ''));
    const la = row.indexOf('class="tipg a"'); if (la < 0) return;
    const lb = row.indexOf('class="tipg b"', la), list = row.slice(la, lb < 0 ? row.length : lb), n = {};
    list.replace(/<span class="td">([^<]*)<\/span><span class="tx">([\s\S]*?)<\/span><span class="ta">([^<]*)<\/span>/g, (all, d, tx, ta) => {
      const dm = /^(\d{1,2}) ([A-Za-z]{3})$/.exec(text(d)), mon = dm ? MONTHS.indexOf(dm[2].toLowerCase()) : -1, amt = money(ta);
      if (mon < 0 || !(amt > 0)) return '';
      // the year: the newest one that does not put the line after the build's day
      let y = Number(day.slice(0, 4)), date = y + '-' + ('0' + (mon + 1)).slice(-2) + '-' + ('0' + dm[1]).slice(-2);
      if (date > day) date = (y - 1) + date.slice(4);
      const id = x[1] + '|' + date + '|' + text(tx) + '|' + amt.toFixed(2); n[id] = (n[id] || 0) + 1;
      o[x[2]].push({ d: date, h: key(id + '|' + n[id]), amt: amt, tx: text(tx) });
      return '';
    });
  });
  return o.inn === null || o.out === null ? null : o;
}
// One build's cash into the kept cash (see the top). C = st.cash, c = cashOf's, day = the build's New York date.
function cashStep(C, c, day){
  const cents = v => Math.round(v * 100) / 100;
  const put = (o, d, col, amt) => { const r = o[d] || (o[d] = [0, 0]); r[col] = cents(r[col] + amt); if (!r[0] && !r[1]) delete o[d]; };
  if (!C.open) C.open = day;
  [['inn', c.pays, 0], ['out', c.buys, 1]].forEach(x => {
    const col = x[2], items = x[1];
    let oldest = day; const fresh = [];
    items.forEach(it => {
      if (it.d < oldest) oldest = it.d;
      if (C.seen[it.h]) return;
      C.seen[it.h] = it.d; put(C.days, it.d, col, it.amt); C.sum[col] = cents(C.sum[col] + it.amt); fresh.push(it);
    });
    const diff = cents(c[x[0]] - C.sum[col]);
    if (Math.abs(diff) < 1) return;                              // (the totals are in whole dollars, the lines in cents)
    if (diff > 0){ const d = items.length >= FULL_LIST ? oldest : day; put(C.days, d, col, diff); put(C.rest, d, col, diff); C.sum[col] = cents(C.sum[col] + diff); return; }
    // more booked than the total says: dated lines came for cash that was booked from the totals. Each new line takes its
    // amount back from the first such days on or after its own date (the total rose on the day of the line or later); what
    // is then still over comes off the newest ones.
    let back = -diff;
    const take = (d, most) => {
      const t = Math.min(back, most, C.rest[d] ? C.rest[d][col] : 0); if (!(t > 0)) return 0;
      put(C.rest, d, col, -t); put(C.days, d, col, -t); C.sum[col] = cents(C.sum[col] - t); back = cents(back - t); return t;
    };
    const rests = () => Object.keys(C.rest).filter(d => C.rest[d][col] > 0).sort();
    fresh.slice().sort((p, q) => p.d < q.d ? 1 : p.d > q.d ? -1 : 0).forEach(it => {
      let left = it.amt + 0.99;                                  // (a day booked from a total is in whole dollars)
      rests().filter(d => d >= it.d).forEach(d => { if (left > 1 && back >= 0.005) left -= take(d, left); });
    });
    rests().reverse().forEach(d => { if (back >= 0.005) take(d, back); });
    // (a total that fell with nothing to take it from: the dashboard corrected itself, the day of the build carries it)
    if (back >= 1){ put(C.days, day, col, -back); C.sum[col] = cents(C.sum[col] - back); }
  });
  // the dated lines are remembered for as long as a list can still show them
  Object.keys(C.seen).forEach(h => { if (dayNo(day) - dayNo(C.seen[h]) > KEEP_SEEN_DAYS) delete C.seen[h]; });
}
function cashNew(){ return { open: '', sum: [0, 0], days: {}, rest: {}, seen: {} }; }
// The evals a build shows open, and one build's number into the kept ones (see the top). O = st.open, day = the build's New York date.
function openOf(snap){ return snap.eval.filter(r => !r.passed && !r.dead).length; }
function firmsOf(snap){ const m = {}; snap.eval.forEach(r => { if (r.passed || r.dead) return; const f = String(r.firm || '').trim().toLowerCase(); m[f] = (m[f] || 0) + 1; }); return m; }
// The evals a build shows for the first time, by firm: the fleet's buys of that day (O.buys). O.seen = each eval's hash and the
// date it was last shown, kept KEEP_BOUGHT_DAYS so that one that drops out of a build and comes back is not bought twice. The
// first build read only fills seen: what it shows was there before.
function buyStep(O, snap, day){
  if (!O.buys) return;
  const first = !O.seen; if (first) O.seen = {};
  snap.eval.forEach(r => { const h = key(r.id); if (!O.seen[h] && !first){ const f = String(r.firm || '').trim().toLowerCase(), m = O.buys[day] || (O.buys[day] = {}); m[f] = (m[f] || 0) + 1; } O.seen[h] = day; });
  const old = new Date(Date.parse(day + 'T00:00:00Z') - KEEP_BOUGHT_DAYS * 864e5).toISOString().slice(0, 10);
  Object.keys(O.seen).forEach(h => { if (O.seen[h] < old) delete O.seen[h]; });
  const ds = Object.keys(O.days).sort(), cut = ds.length > KEEP_OPEN_DAYS ? ds[ds.length - KEEP_OPEN_DAYS] : ''; Object.keys(O.buys).forEach(d => { if (d < cut) delete O.buys[d]; });
}
// Payouts, account by account (pk of a counts file). The owner, 28 Nov 2026: "if we keep buying and math get bad or good it
// updates automatically". The page told an account's payout cycle by its count: "n/4 days" before its first payout, "n/5 days"
// after one. Since 26 Nov 2026 both dashboards show "n/5 days" before every payout (FuturesElite did from its first accounts on
// 23 Nov), so the count no longer tells it, and an account still before its first payout was taken for one after it.
// pk.a = { tagOf(account): [days won so far, days its payout needs, 1 while "payout requested", payouts seen, the New York date
// it was last listed] }. A payout: its count falls (the dashboard starts a new count after each payout). Not the end of
// "payout requested": a row can go back to its full count ("5/5 days") until the money is out, or show the request after
// its new count has started (V2's Lucid on 18 Nov 2026, G1's Aqua on 15 to 24 Nov). At the change of 26 Nov counts rose, none fell.
// An account new in the flips has had none (it has just won its funded trade); only on the first build read (pk.s = 0) are
// they older accounts, told by the count of then (4 before the first payout, 5 after). pk.d1, pk.d = the count most accounts
// show before their first payout and after one, as the rows show them now.
// What a payout brought (the owner, 28 Nov 2026, of the plan's $1,782 for a first payout where Lucid paid $1,537 and Topstep $1,463
// on average: "Use real averages"): a line of the Cash box's Received list that names an account in the flips is that account's
// payout. Each account also keeps the payouts it was seen with first (k0) and its firm and size, and how many Received lines
// have named it; the first line of one seen from before its first payout is its first payout. pk.f = { firm|size: what the
// last PAY_KEEP first payouts brought }, pk.seen = the lines read. pk.pool = both fleets' pk.f together (a firm pays alike).
function tagOf(id){
  const s = String(id || '').trim().replace(/\s+/g, ' '); let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
function payNew(){ return { d1: 4, d: 5, s: 0, a: {} }; }
// How long a payout takes (the owner, 28 Nov 2026: "Yes, fix them", of the page's fixed 7 trading days for Aqua): each account
// also keeps a[8] = the day its payout came due (the last trade of the cycle's last winning day: when its count is full, or when
// it shows "payout requested" first) and a[9] = a payout seen ([due, paid, 1 once "payout requested" followed it]) until it is
// settled. Paid = the day the dashboard started its new count; where "payout requested" came after that (G1's Aqua, 15 to 24 Nov
// 2026), the day that ended. pk.w = { firm|size: [due, paid] of the last PAY_KEEP payouts }, pk.wpool = both fleets' together.
function lastTradeOn(r, day){
  const m = /^(\d\d)-(\d\d)$/.exec(r.day || ''); if (!m) return '';
  // (the dashboard's trading day rolls at 18:00 ET, so in the evening it is a day or three ahead of New York's date)
  const y = Number(day.slice(0, 4)); let d = y + '-' + m[1] + '-' + m[2]; if (dayNo(d) - dayNo(day) > 7) d = (y - 1) + d.slice(4);
  return d;
}
function waitPush(P, u, due, paid){ const w = P.w[u] || (P.w[u] = []); w.push([due, paid]); if (w.length > PAY_KEEP) w.shift(); }
function payStep(P, snap, day, cash){
  const seed = !P.s;
  if (!P.f) P.f = {};
  if (!P.seen) P.seen = {};
  if (!P.w) P.w = {};
  // paid on the dashboard's trading day of the build (the last trades are in trading days too)
  const tday = lastTradeOn({ day: snap.date }, day) || day;
  snap.flip.forEach(r => {
    const t = tagOf(r.id), n = r.days ? r.days[0] : null, m = r.days ? r.days[1] : null, a = P.a[t], lt = lastTradeOn(r, day);
    if (!a){ const k0 = seed && m !== null && m > 4 ? 1 : 0; P.a[t] = [n, m, r.req ? 1 : 0, k0, day, k0, unit(r, false), 0, r.req || (n !== null && n >= m) ? lt || day : '', 0]; return; }
    a[4] = day;
    if (r.req){ if (a[9]) a[9][2] = 1; else if (!a[8]) a[8] = lt || day; a[2] = 1; return; }
    if (n === null) return;
    if (a[0] !== null && n < a[0]){
      a[3]++;
      const due = a[8] || lt || day;
      if (a[2] === 1) waitPush(P, a[6], due, tday); else a[9] = [due, tday, 0];
      a[8] = '';
    } else {
      if (a[9] && a[2] === 1 && a[9][2]){ waitPush(P, a[6], a[9][0], tday); a[9] = 0; }
      else if (a[9] && a[0] !== null && n > a[0]){ waitPush(P, a[6], a[9][0], a[9][1]); a[9] = 0; }
      if (!a[8] && !a[9] && m !== null && n >= m) a[8] = lt || day;
    }
    a[0] = n; a[1] = m; a[2] = 0;
  });
  P.s = 1;
  // the Received lines not read yet: the account it names (its number, or the end of it), among the accounts listed now
  if (cash) cash.pays.forEach(it => {
    if (P.seen[it.h]) return; P.seen[it.h] = day;
    const last = String(it.tx || '').trim().split(' ').pop(); if (last.length < 5) return;
    const r = snap.flip.find(x => x.id === last || x.id.indexOf(last) >= 0 || last.indexOf(x.id) >= 0), a = r && P.a[tagOf(r.id)]; if (!a || a.length < 8) return;
    a[7]++;
    if (a[5] === 0 && a[7] === 1){ const f = P.f[a[6]] || (P.f[a[6]] = []); f.push(Math.round(it.amt * 100) / 100); if (f.length > PAY_KEEP) f.shift(); }
  });
  Object.keys(P.seen).forEach(h => { if (dayNo(day) - dayNo(P.seen[h]) > KEEP_SEEN_DAYS) delete P.seen[h]; });
  // the counts the rows show now: the one most of them show, before a first payout and after one
  const most = (x) => { let b = null, bn = 0; Object.keys(x).forEach(m => { if (x[m] > bn){ b = +m; bn = x[m]; } }); return b; }, c0 = {}, c1 = {};
  snap.flip.forEach(r => { if (!r.days) return; const a = P.a[tagOf(r.id)], c = a[3] ? c1 : c0; c[r.days[1]] = (c[r.days[1]] || 0) + 1; });
  if (most(c0)) P.d1 = most(c0); if (most(c1)) P.d = most(c1);
  Object.keys(P.a).forEach(t => { if (dayNo(day) - dayNo(P.a[t][4]) > KEEP_PAY_DAYS) delete P.a[t]; });
}
function payPool(dir){
  const files = FLEETS.map(k => path.join(dir, k + '.json')), sts = files.map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e){ return null; } }), pool = {};
  const wpool = {};
  sts.forEach(st => { if (st && st.pk && st.pk.f) Object.keys(st.pk.f).forEach(u => { pool[u] = (pool[u] || []).concat(st.pk.f[u]); }); });
  sts.forEach(st => { if (st && st.pk && st.pk.w) Object.keys(st.pk.w).forEach(u => { wpool[u] = (wpool[u] || []).concat(st.pk.w[u]); }); });
  sts.forEach((st, i) => { if (!st || !st.pk) return; if (JSON.stringify(st.pk.pool || {}) === JSON.stringify(pool) && JSON.stringify(st.pk.wpool || {}) === JSON.stringify(wpool)) return; st.pk.pool = pool; st.pk.wpool = wpool; fs.writeFileSync(files[i], dump(st)); });
}
function openStep(O, n, day, firms){
  const up = !(O.days[day] >= n);
  if (up) O.days[day] = n;
  if (O.avg){ const a = O.avg[day] || (O.avg[day] = [0, 0]); a[0] += n; a[1]++; }
  if (firms && (up || (O.days[day] === n && !(O.firms && O.firms[day])))){ if (!O.firms) O.firms = {}; O.firms[day] = firms; }
  const ds = Object.keys(O.days).sort(); ds.slice(0, Math.max(0, ds.length - KEEP_OPEN_DAYS)).forEach(d => { delete O.days[d]; if (O.firms) delete O.firms[d]; if (O.avg) delete O.avg[d]; });
}

// What one build of the dashboard shows for a fleet, or null when its section cannot be trusted:
// the three tables have to be there with as many rows as the tabs above them say. built: the build's time (its commit's),
// for its trading day when the footer does not say it.
function read(html, k, built){
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
  // the trading day (it rolls at 18:00 ET), and the date a trade of that day carries in the "Last trade" column: as the
  // footer says it, else from the build's time (tradingDay)
  const fi = html.indexOf('class="foot"'), foot = text(html.slice(fi < 0 ? 0 : fi)), day = /Trading day ([A-Za-z]{3}) (\d{1,2}) ([A-Za-z]{3})/.exec(foot), mon = day ? MONTHS.indexOf(day[3].toLowerCase()) : -1;
  let td = null;
  if (day){ if (mon >= 0) td = { name: day[1] + ' ' + (+day[2]) + ' ' + day[3], m: mon + 1, d: +day[2] }; }
  else if (built) td = tradingDay(built, foot);
  if (!td) return null;
  snap.day = td.name;
  snap.date = ('0' + td.m).slice(-2) + '-' + ('0' + td.d).slice(-2);
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

// New York's date and time at a moment (ms): { y, m, d, h, mi }
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function nyAt(ms){ const p = {}; NY.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = Number(x.value); }); return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute }; }
function dayAfter(y, m, d, n){ const t = new Date(Date.UTC(y, m - 1, d + n)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
// The trading day of a build the dashboard made at `built` (its commit time) whose footer says no trading day (since 16 Nov
// 2026 21:56 UTC it says only "Updated 08:17 ET"): the New York time of the build, which is the footer's "Updated" time,
// the last one at or before the commit (the day before when it is later in the day than the commit by more than SLACK
// minutes, which the two clocks may differ by), else the commit's own; from 18:00 on, the next day; a Saturday or a Sunday,
// the Monday after. That is the trading day each of the 1,763 builds from 5 to 16 Nov 2026 that carried "Trading day Ddd D
// Mon" says, Friday evenings and weekends included. Returns { name: 'Mon 16 Nov', m, d } or null.
const SLACK = 15;
function tradingDay(built, foot){
  const ms = Date.parse(built); if (!isFinite(ms)) return null;
  let { y, m, d, h, mi } = nyAt(ms);
  const up = /Updated (?:\(page built\) )?(\d{1,2}):(\d\d) ?ET/.exec(foot || '');
  if (up && +up[1] < 24 && +up[2] < 60){
    if (+up[1] * 60 + +up[2] > h * 60 + mi + SLACK) [y, m, d] = dayAfter(y, m, d, -1);
    h = +up[1]; mi = +up[2];
  }
  if (h >= 18) [y, m, d] = dayAfter(y, m, d, 1);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 6) [y, m, d] = dayAfter(y, m, d, 2); else if (wd === 0) [y, m, d] = dayAfter(y, m, d, 1);
  return { name: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ' ' + d + ' ' + MON[m - 1], m: m, d: d };
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
// What is remembered of an account: p = its table (e eval, f funded, x flip), f = its firm, z = its result is in the counts,
// r = a funded stage that is not its first, gone = the date it left the dashboard, u = its result was set because it left.
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
  // A row with no trade yet (no date in "Last trade", which says "none yet", no day P&L, no total) is a new account whose
  // numbers have not loaded: the dashboard often first lists a new eval or funded account that way, with $0 of room
  // ("Topstep | $0 | $0 | $0 | none yet"). It is neither out nor a result, so its real result is counted when it comes
  // (until 20 Nov 2026 such a row was taken as out with an older result, and that account was never counted).
  const fresh = r => !r.dead && !r.passed && !r.day && !r.dayPnl && !r.pnl;
  const out = r => r.dead || (!fresh(r) && r.room !== null && r.room <= 0);
  // An account that was gone is back. If its result was set only because it left (u: 1 = counted here, 2 = left on a build
  // with the Lifetime table, so not counted here) and it is not out after all, it is running again: a count made here is taken back.
  const back = (a, r, k, h, stillOut) => {
    if (a.u){
      if (!stillOut){
        if (a.u === 1 && !based){ st.counts[k][1]--; note('back on the dashboard: its count is taken back', r.firm, h); }
        delete a.z;
      }
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
    a.z = 1; a.u = based ? 2 : 1;
    if (based) return;                                         // the table has it, whatever it was
    add(a.p === 'e' ? 'pass' : 'win', false);
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
  const head = ['v', 'at', 'built', 'unread', 'day', 'counts', 'flipDone', 'base', 'today', 'cash', 'open', 'pk'].filter(k => st[k] !== undefined).map(k => ' ' + JSON.stringify(k) + ': ' + JSON.stringify(st[k])).join(',\n');
  const lines = a => a.length ? '\n' + a.map(l => '  ' + JSON.stringify(l)).join(',\n') + '\n ' : '';
  return '{\n' + head + ',\n "marks": [' + lines(st.marks || []) + '],\n "acc": {' + (rows ? '\n' + rows + '\n ' : '') + '},\n "log": [' + lines(st.log) + ']\n}\n';
}
// everything in a counts file except how far it has read
function body(st){ const o = copy(st); delete o.at; delete o.built; return JSON.stringify(o); }

// (windowsHide: on a Windows PC, where the counter also runs as a scheduled task, no git call may open a window)
function git(dir, args){ return cp.execFileSync('git', ['-C', dir].concat(args), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
// the builds after one commit (all of them when none is given), oldest first
function builds(dir, after){
  return git(dir, ['log', '--reverse', '--format=%H %cI', after ? after + '..HEAD' : 'HEAD', '--', 'index.html']).trim().split('\n').filter(Boolean)
    .map(l => { const p = l.split(' '); return { sha: p[0], built: new Date(p[1]).toISOString() }; });
}
function page(dir, sha){ return git(dir, ['show', sha + ':index.html']); }
function reaches(dir, sha){ try { git(dir, ['merge-base', '--is-ancestor', sha, 'HEAD']); return true; } catch (e){ return false; } }

function main(){
  const dir = process.argv[2], dash = process.argv[3], mode = process.argv[4], refill = mode === '--cash' || mode === '--open' || mode === '--pays';
  if (!dir || !dash){ console.error('usage: node tools/track.js <folder> <clone of the dashboard repository>'); process.exit(2); }
  const cache = {}, shown = sha => cache[sha] || (cache[sha] = page(dash, sha));
  if (refill){
    // every build once, oldest first, up to the one each counts file has read: its cash from the start
    const sts = {}, all = builds(dash);
    FLEETS.forEach(k => { try { const st = JSON.parse(fs.readFileSync(path.join(dir, k + '.json'), 'utf8')); if (st && st.v === 2 && st.at){ if (mode === '--cash') st.cash = cashNew(); else if (mode === '--pays') st.pk = payNew(); else st.open = { days: {}, avg: {}, buys: {} }; sts[k] = { st: st, done: false }; } } catch (e) {} });
    for (const b of all){
      const live = Object.keys(sts).filter(k => !sts[k].done); if (!live.length) break;
      let html = ''; try { html = page(dash, b.sha); } catch (e) {}
      live.forEach(k => {
        if (mode === '--cash'){ const c = html && cashOf(html, k, b.built); if (c) cashStep(sts[k].st.cash, c, nyDate(b.built)); }
        else if (mode === '--pays'){ const snap = html && read(html, k, b.built); if (snap) payStep(sts[k].st.pk, snap, nyDate(b.built), cashOf(html, k, b.built)); }
        else { const snap = html && read(html, k, b.built); if (snap){ openStep(sts[k].st.open, openOf(snap), nyDate(b.built), firmsOf(snap)); buyStep(sts[k].st.open, snap, nyDate(b.built)); } }
        if (b.sha === sts[k].st.at) sts[k].done = true;
      });
    }
    Object.keys(sts).forEach(k => {
      const C = sts[k].st.cash;
      if (!sts[k].done){ console.log(k + ': the history does not reach the build read last: not written'); return; }
      fs.writeFileSync(path.join(dir, k + '.json'), dump(sts[k].st));
      if (mode === '--open'){ console.log(k + ': open evals ' + JSON.stringify(sts[k].st.open.days)); return; }
      if (mode === '--pays'){ const P = sts[k].st.pk; console.log(k + ': payout days ' + P.d1 + ' then ' + P.d + ' | ' + Object.keys(P.a).length + ' accounts | first payouts ' + JSON.stringify(P.f) + ' | waits ' + JSON.stringify(P.w)); return; }
      console.log(k + ': cash from ' + C.open + ' | received ' + C.sum[0] + ', spent ' + C.sum[1] + ' | ' + Object.keys(C.days).length + ' days');
    });
    if (mode === '--pays') payPool(dir);
    return;
  }
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
      for (; i >= 0; i--){ const snap = read(shown(all[i].sha), k, all[i].built); if (snap && snap.life) break; }
      if (i < 0){ console.log(k + ': no build with a Lifetime table to start from: nothing written'); continue; }
      list = all.slice(i);
    }
    const before = st ? body(st) : '';
    let unread = 0;
    for (const b of list){
      const snap = read(shown(b.sha), k, b.built);
      if (snap){ st = step(st, snap, b); delete st.unread; if (st.open){ openStep(st.open, openOf(snap), nyDate(b.built), firmsOf(snap)); buyStep(st.open, snap, nyDate(b.built)); } if (st.pk) payStep(st.pk, snap, nyDate(b.built), cashOf(shown(b.sha), k, b.built)); }
      else { unread++; if (st && !st.unread) st.unread = b.built; }
      // the cash box is read on its own: a build whose tables cannot be trusted still shows it
      if (st && st.cash){ const c = cashOf(shown(b.sha), k, b.built); if (c) cashStep(st.cash, c, nyDate(b.built)); }
      if (st){ st.at = b.sha; st.built = b.built; }
    }
    if (!st){ console.log(k + ': nothing readable'); continue; }
    // how far it has read is saved with a change, or once enough builds have gone by
    const changed = body(st) !== before, out = dump(st);
    if (out !== old && (changed || list.length >= SAVE_EVERY)) fs.writeFileSync(file, out);
    console.log(k + ': ' + list.length + ' builds read' + (unread ? ' (' + unread + ' not readable)' : '') + ' | ' + KEYS.map(x => x + ' ' + st.counts[x][0] + '/' + st.counts[x][1]).join(', ') + ' | ' + st.day + (st.unread ? ' | not readable since ' + st.unread : '') + (changed ? ' | saved' : ''));
  }
  // both fleets' first payouts into each file (only where they changed)
  payPool(dir);
}
if (require.main === module) main();
module.exports = { tagOf: tagOf, payStep: payStep, payNew: payNew, buyStep: buyStep, firmsOf: firmsOf, openOf: openOf, openStep: openStep, cashOf: cashOf, cashStep: cashStep, cashNew: cashNew, nyDate: nyDate, read: read, step: step, dump: dump, text: text, money: money, key: key, small: small, tradingDay: tradingDay };
