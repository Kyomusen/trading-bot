// broker/capitalStream.js
// WebSocket connection to Capital.com CStream API
// Connects → sends subscribe with cst/securityToken inline → receives price ticks

const WebSocket = require('ws');
const EventEmitter = require('events');
const broker = require('./capitalClient');
const { logEvent } = require('../live/liveLogger.js');

class CapitalStream extends EventEmitter {
  constructor({ epic, brokerEpic }) {
    super();
    this.epic = epic;
    this.brokerEpic = brokerEpic || epic;
    this.host = broker.streamingHost || null;
    this.ws = null;
    this.ready = false;
    this.reconnectDelay = 10000;
    this._retryCount = 0;
    this._maxRetryDelay = 120000;
    this._closedByUs = false;
    this._priceTimer = null;
    this._pingTimer = null;
  }

  async connect() {
    try {
      await broker.ensureSession();
      const host = broker.streamingHost.replace(/\/+$/, '');
      if (!host) throw new Error('streamingHost not provided by session response');
      this.host = host + '/';
      const url = host + '/connect';
      this.ws = new WebSocket(url);
      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('ping', () => { this._lastPing = Date.now(); try { this.ws.pong(); } catch {} });
      this.ws.on('close', () => this._onClose());
      this.ws.on('error', (err) => {
        this.emit('error', err);
        this._onClose();
      });
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this.ready = false;
    this.ws.send(JSON.stringify({
      destination: 'marketData.subscribe',
      correlationId: '1',
      cst: broker.cst,
      securityToken: broker.securityToken,
      payload: { epics: [this.brokerEpic] },
    }));
    this._startPing();
  }

  _startPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          destination: 'ping',
          correlationId: '2',
          cst: broker.cst,
          securityToken: broker.securityToken,
        }));
      }
    }, 300000);
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // subscription response
    if (msg.destination === 'marketData.subscribe' && msg.status === 'OK') {
      if (!this.ready) {
        this.ready = true;
        this._retryCount = 0;
        logEvent(this.epic, { type: 'ws_ready' });
        this.emit('ready');
      }
      return;
    }

    // price update
    if (msg.destination === 'quote' && msg.status === 'OK' && msg.payload) {
      const p = msg.payload;
      if (p.bid == null || p.ofr == null) return;
      const bid = Number(p.bid);
      const ask = Number(p.ofr);
      logEvent(this.epic, { type: 'ws_price', epic: p.epic, bid, ask });
      this.emit('price', {
        epic: p.epic || this.epic,
        bid,
        ask,
        timestamp: p.timestamp != null ? Number(p.timestamp) : Date.now(),
      });
      return;
    }
  }

  _onClose() {
    this.ready = false;
    clearInterval(this._pingTimer);
    this.emit('close');
    if (!this._closedByUs) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closedByUs) return;
    clearTimeout(this._priceTimer);
    this._retryCount++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this._retryCount - 1), this._maxRetryDelay);
    this._priceTimer = setTimeout(() => { this.connect(); }, delay);
  }

  close() {
    this._closedByUs = true;
    clearTimeout(this._priceTimer);
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = { CapitalStream };
