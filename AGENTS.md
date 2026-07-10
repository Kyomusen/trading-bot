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
│   ├── xauStrategy.js         — XAUUSD RSI/EMA/MACD/ADX/BB/Stoch/PSAR/ATR with regime-adaptive SL+trailing
│   └── exampleStrategy.js     — Placeholder: EMA 12/26 cross + RSI filter
├── sizing/
│   ├── index.js               — Dispatcher: เลือก method ตาม config.sizingMethod
│   ├── legacyMaxLot.js        — balance / divisor
│   ├── fixedRisk.js           — (balance × riskPercent) / slDistance
│   └── confidenceBased.js     — risk% scales with signal.confidence (placeholder)
├── engine/
│   ├── positionManager.js     — calcTrailingStop
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
- **.env** loaded via `dotenv` (`require('dotenv').config()` at top of `index.js`) into `process.env` — keys: `CAPITAL_API_KEY`, `CAPITAL_IDENTIFIER`, `CAPITAL_PASSWORD`, `CAPITAL_ENV`, `DISCORD_WEBHOOK_URL`
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
| 2026-07 | Real bid/ask data (avg spread 0.46 ≈ 46 pips) | Replaced fixed spread assumption with actual bid/ask from Dukascopy/HF (99,250 candles, 2009–2026) | `data/historical/XAUUSD_bidask.json` — `brokerSimulator` uses bid/ask for entry/stop/pnl |

## Status: Research-Grade Backtest — Needs Forward Test

**ยังไม่พร้อมเทรดจริง** ต้องผ่าน forward test บน demo ก่อน

### Backtest Validation Summary (Real Bid/Ask Data)

| Test | Result | หมายเหตุ |
|------|--------|----------|
| Real bid/ask spread (avg 0.46) | ✅ PF 2.69, DD 3.37%, WR 86.9% | 17 ปี (2009–2026), 13,644 trades |
| Signal-quality filters | ✅ | `bbWidthMinPct:1.0`, `psarAlign:false` |
| Session optimization [0,18] UTC | ✅ | 13/200 เดือนขาดทุน |
| Vol-regime dynamic SL/trailing | ✅ เสถียรทุกยุค (generic bands, causal) | Early era PF 1.4/3.0/1.6, late era 2.7/3.0/2.7 |
| Era stability (2009–2015 vs 2022–2026) | ✅ PF>1 ทุกกรณี | พิสูจน์ non-overfit |
| **New entry models** (donchian, keltner, ema_cross, adx_di) | ❌ ไม่ดีขึ้น | ใหม่ทุกแบบลด risk-adjusted return — baseline momentum+trend ดีที่สุด |
| **TD=0.1 tighter trailing** | ✅ **PF 2.69, DD 3.37%, negMo 13/200** | Key discovery: tight trailing gives highest risk-adjusted |

### Current Backtest Result (XAUUSD, 2009–2026, real bid/ask, 1% risk)
| Metric | Value |
|--------|-------|
| Trades | 13,644 |
| Win Rate | 86.9% |
| Profit Factor | 2.69 |
| Max DD (equity) | 3.37% |
| Sharpe / Sortino | 5.58 / 9.18 |
| Avg Monthly Return | 2.46% |
| Negative Months | 13 / 200 (7%) |
| Worst Month | −0.63% |
| Years with PF<1 | 0 |

### ข้อจำกัดของ Backtest ที่ยังไม่ครอบคลุม
- **Regime change**: Bootstrap MC สุ่มจากเทรดเดิม ไม่ได้จำลองตลาด sideway หรือ volatility crash
- **Tick-level**: ใช้ H1 OHLC ไม่รู้ว่าเกิด whipsaw ภายในแท่ง หรือ slippage ตอนเข้า/ออก
- **Execution**: ยังไม่จำลอง network latency, requote, หรือ fills บางส่วน

### Forward Test Plan
```
1. เปิดบัญชี Demo บน Capital.com
2. รัน live loop (node index.js live) อย่างน้อย 2–3 เดือน
3. เปรียบเทียบผลกับ backtest: WR, PF, Avg PnL/month, Max DD
4. ถ้าผลใกล้เคียง → เริ่ม live ด้วยขนาดเล็ก (1% risk)
5. monitor spread จริง ถ้า spread เกิน avg มาก → reduce lot หรือ pause
```

### Existing Caveats (not closed)
- Discord notifications ถูก integrate แล้ว แต่ error webhook ยังไม่มี
- WebSocket live streaming ยังไม่ implement (polling 60s อาจพลาด)
- [ ] WebSocket live streaming (currently polling every 60s)
- [ ] State persistence (`live_state.json`, `live_trades.json`)
- [ ] Full trailing stop modes (snap/two_stage/be_trail from _Bot)
- [ ] Discord error webhook
- [ ] Duplicate signal filter integration
- [ ] Market open/close detection + auto-retry

## Constraints

- Do not commit `.env` — contains real credentials
- All indicators are in `utils/indicators.js` (no `technicalindicators` dependency used yet, but installed)
- Backtest uses real bid/ask data (`XAUUSD_bidask.json`, avg spread 0.46 ≈ 46 pips). Config: atrSl=2.0, trailingDist=0.1, trailingActivate=0.1, maxConcurrentTrades=2, filters={bbWidthMinPct:1.0,psarAlign:false}, tradingHours={windows:[[0,18]]}, adaptiveVol=true
- Live code skips entry if spread >125% of config, and dynamically reduces maxLot proportionally
- EURUSD is disabled in config by default (only XAUUSD + USDJPY active)
