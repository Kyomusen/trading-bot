// config.js
// รวมค่าตั้งค่าทั้งหมดของบอทไว้ที่เดียว แก้ตรงนี้ที่เดียวพอ

module.exports = {
  // ===== Capital.com credentials =====
  capital: {
    apiKey: process.env.CAPITAL_API_KEY || '',
    identifier: process.env.CAPITAL_IDENTIFIER || '',
    password: process.env.CAPITAL_PASSWORD || '',
    baseUrl: process.env.CAPITAL_ENV === 'demo'
      ? 'https://demo-api-capital.backend-capital.com'
      : 'https://api-capital.backend-capital.com',
  },

  // ===== Symbols ที่บอทเทรด =====
  symbols: [
    {
      epic: 'XAUUSD',
      brokerEpic: 'GOLD',
      displayName: 'XAUUSD',
      leverage: 20,        // Gold Spot: Capital.com สูงสุด 20:1
      pipValue: 0.01,
      enabled: true,
      timeframe: 'H1',
      trendTf: 'H4',
      candles: 125000,
      riskPercent: 1,
      offset: 0,
      trendMode: 'OR',
      tradingHours: null,  // null = 24/7
      spreadMultiplier: 1.0,  // เทียบกับ Capital.com: spread จริง × factor (1.0 = raw Dukascopy)
      trailing: true,
      trailingActivate: 0.1,
      trailingDistance: 0.1,
      trailingDistanceMax: 0.6,
      adaptiveVol: true, // ปรับ SL/trailing ตาม regime ความผันผวน (ATR vs MA ระยะยาว) — dynamic ไร้ overfit
      trailingProgressive: 0,
      atrSl: 2.0,
      spreadPips: 25,
      slippagePips: 2,
      maxLot: 5,
      maxDd: 50,
      activeSetups: ['trend_buy', 'trend_sell', 'momentum_buy', 'momentum_sell'],
      filters: {
        bbWidthMinPct: 1.0, // กรองสัญญาณแย่: ไม่เทรดตอน Bollinger แคบ (sideway/chop) — ลด whipsaw
        psarAlign: false,   // ไม่บังคับ PSAR align (ปล่อยสัญญาณมากขึ้น)
      },
      tradingHours: { windows: [[0, 18]] }, // เทรดเฉพาะสภาพคล่องสูง UTC 00-18 (Asian+London+London/NY overlap + 2h early NY) — ลด DD จาก NY thin hours
      rsi: {
        trend_buy: { min: 25, max: 50 },
        trend_sell: { min: 50, max: 75 },
        momentum_sell: { min: 20, max: 45 },
        momentum_buy: { min: 50, max: 65 },
      },
      strategy: {
        emaFast: 9,
        emaSlow: 21,
        rsiPeriod: 14,
        rsiOverbought: 70,
        rsiOversold: 30,
        atrPeriod: 14,
        slMultiplier: 1.5,
        tpMultiplier: 2.5,
      },
    },
    {
      epic: 'USDJPY',
      displayName: 'USDJPY',
      leverage: 30,        // Major Forex: Capital.com สูงสุด 30:1
      pipValue: 0.01,
      enabled: false,
      timeframe: 'H1',
      trendTf: 'H4',
      candles: 90000,
      riskPercent: 1,
      offset: 0,
      trendMode: 'OR',
      trailing: true,
      trailingActivate: 0.05,
      trailingDistance: 0.2,
      trailingDistanceMax: 0.5,
      trailingProgressive: 0,
      atrSl: 1.5,
      spreadPips: 2,
      slippagePips: 1,
      maxLot: 5,
      maxDd: 50,
      activeSetups: ['trend_buy', 'trend_sell'],
      strategy: {
        emaFast: 9,
        emaSlow: 21,
        rsiPeriod: 14,
        rsiOverbought: 70,
        rsiOversold: 30,
        atrPeriod: 14,
        slMultiplier: 1.5,
        tpMultiplier: 2.5,
      },
    },
    {
      epic: 'EURUSD',
      displayName: 'EURUSD',
      leverage: 30,        // Major Forex: Capital.com สูงสุด 30:1
      pipValue: 0.0001,
      enabled: false,
      timeframe: 'H1',
      trendTf: 'H4',
      candles: 50000,
      riskPercent: 1,
      offset: 0,
      trendMode: 'OR',
      trailing: true,
      trailingActivate: 0.05,
      trailingDistance: 0.2,
      trailingDistanceMax: 0.5,
      trailingProgressive: 0,
      atrSl: 1.5,
      spreadPips: 1,
      slippagePips: 1,
      maxLot: 5,
      maxDd: 50,
      activeSetups: ['trend_buy', 'trend_sell'],
      strategy: {
        emaFast: 9,
        emaSlow: 21,
        rsiPeriod: 14,
        rsiOverbought: 70,
        rsiOversold: 30,
        atrPeriod: 14,
        slMultiplier: 1.5,
        tpMultiplier: 2.5,
      },
    },
  ],

  // ===== Position sizing =====
  sizingMethod: 'fixedRisk',

  sizing: {
    legacyMaxLot: {
      divisor: 50000,
    },
    fixedRisk: {
      riskPercent: 1.0,
    },
    confidenceBased: {
      baseRiskPercent: 1.0,
      maxRiskPercent: 2.0,
    },
    // ขีดจำกัดขนาด position: dynamic (คำนวณจาก balance × leverage ของ symbol)
    maxLot: {
      mode: 'dynamic',   // 'dynamic' = ปล่อยให้ fixedRisk sizing ทำงานภายในเพดาน leverage ของ symbol
      floor: 0.01,       // ขนาดต่ำสุดต่อ position
    },
  },

  // ===== Engine (trailing stop / adaptive multiplier) =====
  engine: {
    trailingStop: {
      enabled: true,
      atrMultiplier: 1.5,
    },
    maxDealSizeSafetyMargin: 0.95,
  },

    // ===== Risk guardrails =====
  risk: {
    maxConcurrentTrades: 2,
  },

  // ===== Broker (margin / leverage) =====
  // จุดเดียวที่กำหนดเพดาน notional + margin สำหรับทั้ง simulator และการคำนวณขนาด position
  // (brokerSimulator อ่านค่านี้เพื่อคำนวณ margin/stop-out, sizing ใช้ leverage เดียวกัน)
  broker: {
    leverage: 30,         // default หาก symbol ไม่ระบุ (retail major FX = 30:1)
    stopOutLevel: 0.5,     // บังคับปิดเมื่อ margin level (equity/usedMargin) ตกถึง 50% (มาตรฐาน retail)
    withdraw: {
      frequency: 'quarterly', // 'monthly' | 'quarterly' | null(ไม่ถอน)
      targetMultiple: 5,     // ไม่ถอนจนกว่าพอร์ตจะโตถึง 5× ของเงินเริ่มต้น
      // เมื่อถึงเป้า: ถอนเฉพาะส่วนที่เกินระดับทุนที่ตั้งไว้ (target = startingBalance × targetMultiple) รายไตรมาส
    },
  },

  // ===== Notification =====
  notify: {
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
      enabled: true,
    },
  },

  // ===== Backtest =====
  backtest: {
    startingBalance: 1000,
    dataPath: './data/historical',
    outputDir: './backtest/output', // ไฟล์ผลลัพธ์ (JSON summary + CSV รายเทรด) จะเขียนลงที่นี่
    exitOnOppositeSignal: false, // ทดสอบ: ปิดออเดอร์เมื่อมีสัญญาณสวนทาง (default ปิดเฉพาะเมื่อ hit SL/TSL เหมือนเดิม)
    entryCooldownCandles: 0, // จำนวนแท่ง (H1) ที่ต้องรอหลังออเดอร์ปิด ก่อนเปิดออเดอร์ใหม่ (ลด overtrading/serial correlation)
  },

};
