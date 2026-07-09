# Trading Bot — สถาปัตยกรรมใหม่

## โครงสร้าง

```
trading-bot/
├── config.js                  # ทุกค่า config อยู่ที่นี่
├── broker/
│   ├── capitalClient.js       # เรียก Capital.com API จริง
│   └── brokerSimulator.js     # จำลอง broker interface เดียวกัน สำหรับ backtest
├── signals/
│   ├── exampleStrategy.js     # ตัวอย่างกลยุทธ์ EMA cross + RSI
│   └── index.js                # registry รวมทุกกลยุทธ์
├── sizing/
│   ├── legacyMaxLot.js         # วิธีเดิม balance/50000
│   ├── fixedRisk.js            # วิธีใหม่ risk% x slDistance
│   ├── confidenceBased.js      # placeholder รอออกแบบ metric
│   └── index.js                # เลือกวิธีตาม config.sizingMethod + clamp maxDealSize
├── engine/
│   ├── positionManager.js      # trailing stop (calcTrailingStop)
│   └── tradeEvent.js           # สร้าง TradeEvent (immutable) — จุดเดียวที่คำนวณ PnL
├── live/runLive.js             # loop เทรดสด ใช้ capitalClient
├── backtest/runBacktest.js     # loop จำลอง ใช้ brokerSimulator, logic เดียวกับ live
├── notify/
│   ├── discord/formatter.js    # แปลง TradeEvent เป็น embed เท่านั้น ไม่คำนวณ
│   ├── discord/sender.js       # ส่ง HTTP POST เท่านั้น ไม่คำนวณ
│   └── chart.js                # stub รอย้าย logic จาก chart.js เดิม
├── utils/indicators.js         # ema, rsi, atr
└── index.js                    # entrypoint: node index.js live | backtest
```

## หลักการ

1. **live/backtest แยกไฟล์เต็มตัว** แต่ใช้ `signals/`, `sizing/`, `engine/` ร่วมกัน —
   การตัดสินใจเทรดต้องเหมือนกันเป๊ะไม่ว่าจะรันโหมดไหน
2. **TradeEvent เป็น immutable object** — คำนวณให้เสร็จสมบูรณ์ก่อนส่งเข้า `notify/`
   ไฟล์ `sender.js` ห้ามมี logic คำนวณเด็ดขาด แก้ปัญหาดีเลย์ตรงจุดนี้
3. **sizing เป็น plug-in** — สลับวิธีคำนวณผ่าน `config.sizingMethod` โดยไม่แตะ engine

## สิ่งที่ต้องเติมเองก่อนใช้งานจริง (TODO)

- [ ] `.env` — ใส่ `CAPITAL_API_KEY`, `CAPITAL_IDENTIFIER`, `CAPITAL_PASSWORD`, `DISCORD_WEBHOOK_URL` จริง
- [ ] `signals/exampleStrategy.js` — แทนที่ด้วยกลยุทธ์จริง (โครงสร้าง input/output ให้คงเดิม)
- [ ] `sizing/confidenceBased.js` — ยังเป็น placeholder เชิงเส้น รอออกแบบ metric confidence จริง
- [ ] `notify/chart.js` — ย้าย logic Bresenham line drawing + EMA overlay จาก chart.js เดิม
- [ ] `backtest/runBacktest.js` → `loadHistoricalCandles()` — ชี้ไปยัง historical data จริง (JSON ต่อ epic ใน `config.backtest.dataPath`)
- [ ] ทดสอบ `engine/positionManager.js` (`calcTrailingStop`) ว่าให้ผลตรงตามออกแบบก่อน deploy จริง

## รันยังไง

```bash
npm install
cp .env.example .env   # แล้วกรอกค่าจริง (ไฟล์ต้องอยู่ในโฟลเดอร์ root ของ repo)
npm run backtest        # รัน backtest ทุก symbol ใน config.symbols
npm run live             # รันเทรดสด (dotenv โหลด .env อัตโนมัติ — ไม่ต้อง source .env มือ)
```

## ไม่ได้เอามาจาก GPT proposal (ตั้งใจ)

`riskManager.js`, `signalEngine.js`, `orderManager.js` แยกไฟล์ต่างหาก — ยังไม่มี requirement จริงรองรับ
(เช่น daily loss limit, news filter) การแยกตอนนี้จะเป็น indirection เปล่าๆ เพิ่ม `risk.maxConcurrentTrades`
ไว้ใน `config.js` เป็น guardrail พื้นฐานพอ ถ้าฟีเจอร์ risk เพิ่มขึ้นจริงในอนาคตค่อยแยกไฟล์ตอนนั้น
