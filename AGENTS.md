# Trading Bot (refactored) — AGENTS.md

## Commands

| Command | Action |
|---|---|
| `npm run live` | `node index.js live` — รันเทรดสด |
| `npm run backtest` | `node index.js backtest` — รัน backtest ทุก symbol |

## Architecture

```
index.js (entry: mode = live | backtest)
├── broker/
│   ├── capitalClient.js       — Capital.com REST API (session management, orders)
│   └── brokerSimulator.js     — In-memory simulator (same interface, for backtest)
├── signals/
│   ├── index.js               — Registry: evaluateAll() เรียกทุก strategy
│   ├── xauStrategy.js         — XAUUSD RSI/EMA/MACD/ATR with precalc optimization
│   └── exampleStrategy.js     — Placeholder: EMA 12/26 cross + RSI filter
├── sizing/
│   ├── index.js               — Dispatcher: เลือก method ตาม config.sizingMethod
│   ├── legacyMaxLot.js        — balance / divisor
│   ├── fixedRisk.js           — (balance × riskPercent) / slDistance
│   └── confidenceBased.js     — risk% scales with signal.confidence (placeholder)
├── engine/
│   ├── positionManager.js     — calcTrailingStop + calcAdaptiveMultiplier
│   └── tradeEvent.js          — TradeEvent (immutable, Object.freeze) — PnL calculation
├── live/runLive.js            — Loop live: poll API → signals → sizing → order → notify
├── backtest/runBacktest.js    — Loop backtest: same logic, uses brokerSimulator
├── notify/
│   ├── chart.js               — Stub (รอย้าย Bresenham logic จาก _Bot)
│   └── discord/
│       ├── formatter.js       — TradeEvent → Discord embed (pure transform, no calculation)
│       └── sender.js          — HTTP POST to webhook (no logic, only send)
├── utils/indicators.js        — ema(), rsi(), atr() — pure functions
├── config.js                  — Single source of all config (credentials, symbols, sizing, engine, risk, notify, backtest)
└── data/
    ├── historical/            — {XAUUSD,USDJPY,EURUSD}.json (converted from CSV)
    └── symbols/               — Per-symbol {config.json, strategy.js, data/candles_H1.csv}
```

## Key Conventions

- **CommonJS** modules (not ESM)
- **.env** loaded via `process.env` (no dotenv dependency) — keys: `CAPITAL_API_KEY`, `CAPITAL_IDENTIFIER`, `CAPITAL_PASSWORD`, `CAPITAL_ENV`, `DISCORD_WEBHOOK_URL`
- **Live/Backtest share same path**: signals → sizing → engine → notify. Only broker differs (capitalClient vs brokerSimulator)
- **TradeEvent is immutable** (`Object.freeze`) — all calculation done before notify/. sender.js has zero business logic
- **Sizing is pluggable** — swap via `config.sizingMethod` without touching engine
- Per-symbol config lives in `config.js` (not separate files) — includes `brokerEpic` for Capital.com API (XAUUSD → GOLD)
- Historical data loaded from `data/historical/{epic}.json` (JSON array of `{timestamp, open, high, low, close, volume}`)
- Signal filter: same/opposite direction dedup via `config.signalFilter` (not yet implemented in engine)

## Known Bugs / Bias Fix History

| Date | Bug | Impact | Fix |
|---|---|---|---|
| 2024-07 | Look-ahead: RSI offset `i-13` instead of `i-14` | RSI at candle `i` used candle `i+1` value (1-bar look-ahead) | Changed to `i-14` in `signals/xauStrategy.js:212` |
| 2024-07 | Look-ahead: ATR offset `i-13` instead of `i-14` | ATR at candle `i` used candle `i+1` value (1-bar look-ahead) | Changed to `i-14` in `signals/xauStrategy.js:202` |
| 2024-07 | Spread cost not modeled | Backtest assumed zero spread (XAUUSD real = 20 pips = 0.20) | Added `spreadPips` param to `BrokerSimulator` (`broker/brokerSimulator.js:10`), cost subtracted in `_settle` |

## Status: Research-Grade Backtest — Needs Forward Test

**ยังไม่พร้อมเทรดจริง** ต้องผ่าน forward test บน demo ก่อน

### Backtest Validation Summary

Run `node backtest/validate.js` to reproduce.

| Test | Result | หมายเหตุ |
|------|--------|----------|
| Rolling Walk-forward (17 windows) | ✅ ทุก window กำไร | ใช้ข้อมูล unseen, WR 77.7–81.9% |
| Bootstrap Monte Carlo (5,000) | ✅ 0% negative return | DD@95=20%, DD@99=32% |
| Margin Call (20p spread) | ✅ ไม่เคยโดน | ที่ spread≥30p โดน |
| Spread Impact | ✅ WR/PF ลดลงสมเหตุสมผล | spread=20p → WR 69.5%, PF 2.32 |
| Random Slippage 0–5p | ✅ WR~78.5%, PF~2.66 | robust |
| PnL from broker balance | ✅ Bug แก้แล้ว | tradeEvent ไม่หัก spread → broker balance |
| trailingDistance grid | ⚠️ monotonic trend | เลือก 0.15 เพื่อ robustness |
| Look-ahead bias | ✅ RSI/ATR offset แก้แล้ว | |

### Current Backtest Result (XAUUSD, 2004–2026, spread=20p, dist=0.15)
| Metric | Value |
|--------|-------|
| Trades | 56,907 |
| Win Rate | 69.5% |
| Profit Factor | 2.32 |
| Max DD (equity) | 11.78% |
| Final Balance | $260,537 |
| Return | +25,954% |

### ข้อจำกัดของ Backtest ที่ยังไม่ครอบคลุม
- **Regime change**: Bootstrap MC สุ่มจากเทรดเดิม ไม่ได้จำลองตลาด sideway หรือ volatility crash
- **Margin model**: ใช้แค่ equity threshold ไม่ได้จำลอง leverage/margin level %
- **Tick-level**: ใช้ H1 OHLC ไม่รู้ว่าเกิด whipsaw ภายในแท่ง
- **Spread model**: ใช้ fixed spread ไม่ใช่ spread ที่แปรตาม volatility จริง

### Forward Test Plan
```
1. เปิดบัญชี Demo บน Capital.com
2. รัน live loop (node index.js live) อย่างน้อย 2–3 เดือน
3. เปรียบเทียบผลกับ backtest: WR, PF, Avg PnL/month, Max DD
4. ถ้าผลใกล้เคียง → เริ่ม live ด้วยขนาดเล็ก (1% risk)
5. monitor spread จริง ถ้า >25p → reduce lot หรือ pause
```

### Existing Caveats (not closed)
- trailingDistance=0.15 อาจ loose ไป → monitor forward test ถ้า trail ช้าเกินไป ปรับเป็น 0.10
- Discord notifications ถูก integrate แล้ว แต่ error webhook ยังไม่มี
- WebSocket live streaming ยังไม่ implement (polling 60s อาจพลาด)
- [ ] Implement `notify/chart.js` with Bresenham PNG chart
- [ ] WebSocket live streaming (currently polling every 60s)
- [ ] State persistence (`live_state.json`, `live_trades.json`)
- [ ] Full trailing stop modes (snap/two_stage/be_trail from _Bot)
- [ ] Discord error webhook
- [ ] Duplicate signal filter integration
- [ ] Market open/close detection + auto-retry

### Historical Data with Real Spread
Current backtest uses fixed spreadPips=25. Improvement path:
1. Download tick data from **HistData.com** (free, choose "Tick Data" not M1) — includes bid/ask per tick
2. Or **Dukascopy** community CSVs on GitHub — search "Dukascopy historical data csv"
3. Replace `data/historical/XAUUSD.json` with `{timestamp, bid, ask}` format
4. Update brokerSimulator to check stops against actual bid/ask (not close)
5. This eliminates spread guesswork — backtest matches live conditions exactly

## Constraints

- Do not commit `.env` — contains real credentials
- All indicators are in `utils/indicators.js` (no `technicalindicators` dependency used yet, but installed)
- Backtest config: spreadPips=25, atrSl=1.2, trailingDist=0.15 (live spread = 30p as of Jul 2026 Asian session)
- Live code skips entry if spread >125% of config, and dynamically reduces maxLot proportionally
- EURUSD is disabled in config by default (only XAUUSD + USDJPY active)
