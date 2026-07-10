const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, '..', 'data', 'live_state.json');
const { logEvent } = require('./liveLogger');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch { return {}; }
}

function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { logEvent('system', { type: 'state_write_err', msg: e.message }); }
}

module.exports = { readState, writeState };
