'use strict';
// Publishes the 5ers tab's "Signals a day" record (the owner, 20 Nov 2026: "Yes, extend it": the record grows by a day each
// trading day). A script on the owner's PC, not in this repository, counts the system's signals a trading day once that day
// has ended (every G1 and V2 GO from 13 Jul 2026 walked to the funded target, counted when it fills 60 seconds or more
// after the trade before it has ended) and writes a summary. This reads that summary, checks it, cuts it down to what the
// page shows and writes it as signals.json in the folder given (the "track" branch, next to the counts), where the page
// reads it. Only dates and counts are written: no path, no reason text, nothing else of the summary.
// A summary whose status does not start with "ok" (its own check failed) is not published: the file keeps what it had.
//
// Usage: node tools/signals.js <folder> <summary.json>      It prints one line for the log.
const fs = require('fs'), path = require('path');

const DAY_RX = /^(\d{4})-(\d\d)-(\d\d)$/;
function isDay(s){
  const m = typeof s === 'string' ? DAY_RX.exec(s) : null; if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return +m[1] >= 2020 && +m[1] <= 2100 && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const count = (v, max) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const num = (v, max) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= max;
const c2 = v => Math.round(v * 100) / 100;

// the summary as the page takes it, or { error }
function clean(o){
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'not a summary' };
  if (typeof o.status !== 'string' || !/^ok\b/.test(o.status)) return { error: 'check failed: ' + String(o.status === undefined ? 'no status' : o.status).replace(/\s+/g, ' ').slice(0, 100) };
  const n = o.none_at_same_time, a = o.all_signals;
  if (!isDay(o.first) || !isDay(o.last) || o.first > o.last) return { error: 'first and last are not days in order' };
  if (!count(o.days, 5000) || o.days < 1) return { error: 'days is not a count' };
  if (!count(o.signals, 1e7) || !count(o.counted, 1e7) || o.counted > o.signals) return { error: 'signals and counted are not counts' };
  if (!n || typeof n !== 'object' || !num(n.mean, 1000) || !num(n.median, 1000) || !count(n.min, 1000) || !count(n.max, 1000) ||
      !(n.min <= n.median && n.median <= n.max && n.min <= n.mean && n.mean <= n.max)) return { error: 'the day counts do not add up' };
  if (!isDay(n.min_day) || !isDay(n.max_day) || n.min_day < o.first || n.max_day > o.last || n.max_day < o.first || n.min_day > o.last) return { error: 'the fewest and most days are not in the period' };
  if (Math.abs(n.mean * o.days - o.counted) > o.days * 0.006 + 1e-9) return { error: 'the average is not counted / days' };
  if (!a || typeof a !== 'object' || !num(a.mean, 1000) || a.mean < n.mean || Math.abs(a.mean * o.days - o.signals) > o.days * 0.006 + 1e-9) return { error: 'the average of all signals does not add up' };
  return { v: 1, first: o.first, last: o.last, days: o.days, signals: o.signals, counted: o.counted,
    none: { mean: c2(n.mean), median: c2(n.median), min: n.min, min_day: n.min_day, max: n.max, max_day: n.max_day }, all: { mean: c2(a.mean) } };
}
// one pass: the line to print. The file is written only when what it would hold changed.
function pass(dir, file){
  let o;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return 'signals: no summary to read'; }
  const c = clean(o);
  if (c.error) return 'signals: not published: ' + c.error;
  const out = path.join(dir, 'signals.json'), text = JSON.stringify(c, null, 1) + '\n';
  let old = null; try { old = fs.readFileSync(out, 'utf8'); } catch (e) {}
  const what = c.days + ' days to ' + c.last + ', ' + c.none.mean + ' a day';
  if (old === text) return 'signals: ' + what + ', as kept';
  fs.writeFileSync(out, text);
  return 'signals: ' + what + ', written';
}
if (require.main === module){
  if (process.argv.length < 4){ console.error('usage: node tools/signals.js <folder> <summary.json>'); process.exit(2); }
  console.log(pass(process.argv[2], process.argv[3]));
}
module.exports = { clean: clean, pass: pass, isDay: isDay };
