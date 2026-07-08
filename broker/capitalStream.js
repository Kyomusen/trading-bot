// broker/capitalStream.js
// คลาย wrapping ของ Capital.com streaming (Lightstreamer ผ่าน WebSocket)
// ทำหน้าที่ดึงราคา realtime ของ symbol ที่สนใจ แล้ว emit 'price' events
//   { epic, bid, ask, timestamp }
// เพื่อป้อนเข้า engine/positionTracker (เงาที่จำลอง position แบบ realtime)
//
// NOTE: โปรโตคอล streaming ของ Capital.com เปลี่ยนแปลงได้ และ sandbox นี้ไม่มี network
//       ไปทดสอบจริง จึงเขียนแบบ defensive + มี reconnect + มี REST fallback ใน runLive
//       (ถ้า WS ต่อไม่ได้ จะตกกลับไป poll ราคาผ่าน REST ทุกๆ POLL_MS และป้อนให้ tracker เท่าเดิม)
//
// โปรโตคอลที่ใช้ (ตาม docs ของ Capital.com):
//   1. POST /api/v1/session ( capitalClient.ensureSession ) → ได้ cst, x-security-token, accountId
//   2. เชื่อม WS ไปที่ host streaming แล้วส่ง create_session
//        { "action":"create_session", "arguments":{ "accountId","cst","securityToken" } }
//   3. subscribe ราคา:
//        { "action":"subscribe", "arguments":{ "destination":"marketData.quote.<EPIC>" }, "correlationId":"1" }
//   4. รับข้อความราคา:
//        { "destination":"marketData.quote.<EPIC>", "payload":{ "BID":..,"OFR":..,"UTM":.. } }

const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('../config');
const broker = require('./capitalClient');

function streamingHost() {
  // demo-api-capital.backend-capital.com  → demo-api-streaming-capital.backend-capital.com
  const base = config.capital.baseUrl || 'https://demo-api-capital.backend-capital.com';
  return base.replace('api-capital', 'api-streaming-capital').replace(/^http/, 'ws');
}

class CapitalStream extends EventEmitter {
  constructor({ epic, brokerEpic }) {
    super();
    this.epic = epic;
    this.brokerEpic = brokerEpic || epic;
    this.host = streamingHost();
    this.ws = null;
    this.ready = false;
    this.reconnectDelay = 2000;
    this._closedByUs = false;
    this._priceTimer = null;
  }

  async connect() {
    try {
      await broker.ensureSession();
      const url = `${this.host}/connect`;
      this.ws = new WebSocket(url);
      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
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
      action: 'create_session',
      arguments: {
        accountId: broker.accountId,
        cst: broker.cst,
        securityToken: broker.securityToken,
      },
    }));
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // ตอบรับ session / subscribe
    if (msg.status === 'OK' || msg.action === 'cst_update') {
      if (!this.ready) {
        this.ready = true;
        this.ws.send(JSON.stringify({
          action: 'subscribe',
          arguments: { destination: `marketData.quote.${this.brokerEpic}` },
          correlationId: '1',
        }));
        this.emit('ready');
      }
      return;
    }

    // ข้อความราคา
    const dest = msg.destination || (msg.arguments && msg.arguments.destination);
    if (dest === `marketData.quote.${this.brokerEpic}` && msg.payload) {
      const p = msg.payload;
      const bid = p.BID != null ? Number(p.BID) : undefined;
      const ask = p.OFR != null ? Number(p.OFR) : undefined;
      if (bid == null || ask == null) return;
      this.emit('price', {
        epic: this.epic,
        bid,
        ask,
        timestamp: p.UTM != null ? Number(p.UTM) : Date.now(),
      });
    }
  }

  _onClose() {
    this.ready = false;
    this.emit('close');
    if (!this._closedByUs) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closedByUs) return;
    clearTimeout(this._priceTimer);
    this._priceTimer = setTimeout(() => this.connect(), this.reconnectDelay);
  }

  close() {
    this._closedByUs = true;
    clearTimeout(this._priceTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = { CapitalStream, streamingHost };
