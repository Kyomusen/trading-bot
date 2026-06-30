const WebSocket = require('ws');
const EventEmitter = require('events');

class MarketStream extends EventEmitter {
  constructor(config = {}) {
    super();
    this.cst = config.cst;
    this.securityToken = config.securityToken;
    this.wsUrl = 'wss://api-streaming-capital.backend-capital.com/connect';
    this.ws = null;
    this.subscriptions = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectBaseDelay = 1000;
    this.shouldReconnect = true;
    this.pingTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const timeout = setTimeout(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        for (const epic of this.subscriptions) {
          this._sendSubscribe(epic);
        }
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch {
          // skip unparseable
        }
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.emit('disconnected');
        if (this.shouldReconnect) this._reconnect();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.emit('error', err);
        if (this.reconnectAttempts === 0) reject(err);
      });
    });
  }

  _sendSubscribe(epic) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        destination: 'marketData.subscribe',
        correlationId: epic,
        cst: this.cst,
        securityToken: this.securityToken,
        payload: { epics: [epic] },
      }));
    }
  }

  subscribe(epic) {
    this.subscriptions.add(epic);
    this._sendSubscribe(epic);
    this._startPing();
  }

  unsubscribe(epic) {
    this.subscriptions.delete(epic);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        destination: 'marketData.unsubscribe',
        correlationId: epic,
        cst: this.cst,
        securityToken: this.securityToken,
        payload: { epics: [epic] },
      }));
    }
  }

  _startPing() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          destination: 'ping',
          correlationId: 'ping',
          cst: this.cst,
          securityToken: this.securityToken,
        }));
      }
    }, 300000); // ping every 5 min (< 10 min limit)
  }

  _handleMessage(msg) {
    if (msg.destination === 'ping') return;

    // Subscription confirmation
    if (msg.destination === 'marketData.subscribe') {
      const subs = msg.payload?.subscriptions || {};
      for (const [epic, status] of Object.entries(subs)) {
        if (status === 'PROCESSED') {
          this.emit(`subscribed:${epic}`);
        }
      }
      return;
    }

    if (msg.destination === 'marketData.unsubscribe') return;

    // Price update
    if (msg.destination === 'quote') {
      const epic = msg.payload?.epic;
      if (!epic) return;
      this.emit('price', epic, msg.payload);
      this.emit(`price:${epic}`, msg.payload);
      return;
    }

    // OHLC update
    if (msg.destination === 'ohlc.event') {
      this.emit('ohlc', msg.payload);
      this.emit(`ohlc:${msg.payload?.epic}`, msg.payload);
    }
  }

  _reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }
    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts, delay);
    setTimeout(() => this.connect().catch(() => {}), delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = MarketStream;
