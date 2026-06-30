const WebSocket = require('ws');
const EventEmitter = require('events');

class MarketStream extends EventEmitter {
  constructor(config = {}) {
    super();
    this.cst = config.cst;
    this.securityToken = config.securityToken;
    this.demo = config.demo !== false;
    this.wsUrl = this.demo
      ? 'wss://demo-api-capital.backend-capital.com/'
      : 'wss://api-capital.backend-capital.com/';
    this.ws = null;
    this.subscriptions = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectBaseDelay = 1000;
    this.shouldReconnect = true;
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
        this.ws.send(JSON.stringify({
          destination: 'ADMIN.LOGIN',
          cst: this.cst,
          securityToken: this.securityToken,
        }));
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
          // skip unparseable messages
        }
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        this.emit('disconnected');
        if (this.shouldReconnect) this._reconnect();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this.emit('error', err);
        reject(err);
      });
    });
  }

  _sendSubscribe(epic) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        destination: `PRICES.${epic}`,
        correlationId: epic,
      }));
    }
  }

  subscribe(epic) {
    this.subscriptions.add(epic);
    this._sendSubscribe(epic);
  }

  unsubscribe(epic) {
    this.subscriptions.delete(epic);
  }

  _handleMessage(msg) {
    if (msg.destination === 'ADMIN.LOGIN') return;
    if (!msg.destination || !msg.destination.startsWith('PRICES.')) return;
    const epic = msg.destination.replace('PRICES.', '');
    this.emit('price', epic, msg.payload || msg);
    this.emit(`price:${epic}`, msg.payload || msg);
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = MarketStream;
