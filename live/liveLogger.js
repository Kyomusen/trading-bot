// live/liveLogger.js
// Centralised JSONL logger — ALL writes use fs.appendFileSync for crash safety.
// Every log line is self-contained JSON with a "ts" field (ms epoch of when the
// log entry was written).
//
// Directories:
//   data/live-events/{epic}.jsonl        — system events (WS state, errors, reconcile, etc.)
//   data/live-recorded/{epic}.jsonl      — candles fetched via REST
//   data/live-signals/{epic}.jsonl       — every signal evaluation (indicators, candidates, final)
//   data/live-trades/{epic}.jsonl        — trade open/close events (existing, enhanced)

const fs = require('fs');
const path = require('path');

const BASE = './data';

const DIRS = {
  events:  path.join(BASE, 'live-events'),
  candles: path.join(BASE, 'live-recorded'),
  signals: path.join(BASE, 'live-signals'),
  trades:  path.join(BASE, 'live-trades'),
};

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function append(type, epic, obj) {
  const dir = DIRS[type];
  if (!dir) return;
  ensureDir(dir);
  const row = { ...obj, ts: Date.now() };
  const line = JSON.stringify(row) + '\n';
  try {
    fs.appendFileSync(path.join(dir, `${epic}.jsonl`), line);
  } catch (e) {
    // last-resort fallback – better to lose one line than crash the bot
    try { fs.appendFileSync(path.join(dir, '_fallback.jsonl'), line); } catch {}
  }
}

function logEvent(epic, obj)   { append('events',  epic, obj); }
function logCandle(epic, obj)  { append('candles', epic, obj); }
function logSignal(epic, obj)  { append('signals', epic, obj); }
function logTrade(epic, obj)   { append('trades',  epic, obj); }

module.exports = { logEvent, logCandle, logSignal, logTrade, DIRS };
