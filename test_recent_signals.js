const { fetchCandles } = require('./core/dataSource');
const shared = require('./core/strategy');
const config = require('./symbols/USDJPY/config.json');

(async () => {
  const candles = await fetchCandles('USDJPY', 'h1', 200);
  console.log(`Fetched ${candles.length} candles`);
  console.log(`Range: ${candles[0].time} → ${candles[candles.length-1].time}\n`);

  // Get H4 trend
  let h4Trend = 'neutral';
  try {
    const h4 = await fetchCandles('USDJPY', 'h4', 50);
    const h4Ind = shared.getIndicators(h4);
    h4Trend = h4Ind.emaTrend;
    console.log(`H4 trend: ${h4Trend}\n`);
  } catch { }

  // Analyze each candle from index 60 onwards
  let lastSignal = null;
  for (let i = 60; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const ind = shared.getIndicators(slice);
    const decision = shared.evaluate({ symbol: 'USDJPY', h4Trend, ind, config });

    // Check if near 22:00, 23:00, 00:00
    const t = candles[i].time;
    const h = t.slice(11, 16);

    if (decision && decision.action !== 'NONE') {
      const signalDesc = `${decision.action} (${decision.setup}, conf=${decision.confidence})`;
      if (signalDesc !== lastSignal) {
        console.log(`${t} → ${signalDesc}  ← SIGNAL`);
        lastSignal = signalDesc;
      }
    } else {
      // Show NONE only for the specific times the user asked about
      if (['22:00','23:00','00:00'].includes(h) && t.startsWith('2026-07-01')) {
        const rsi = ind.rsi.toFixed(1);
        const macd = ind.macd.histogram > 0 ? 'pos' : 'neg';
        const trend = ind.emaTrend;
        console.log(`${t} → NONE (trend=${trend}, rsi=${rsi}, macd=${macd})`);
      }
    }
  }

  // Also show all candle closes for July 1 around 20:00-04:00
  console.log('\n=== Detailed July 1 candles ===');
  for (const c of candles) {
    if (c.time.startsWith('2026-07-01') && c.time >= '2026-07-01T20:00' && c.time <= '2026-07-02T04:00') {
      const slice = candles.filter(x => x.time <= c.time);
      if (slice.length < 60) continue;
      const ind = shared.getIndicators(slice);
      const decision = shared.evaluate({ symbol: 'USDJPY', h4Trend, ind, config });
      const signal = decision ? decision.action : 'NONE';
      console.log(`${c.time} O:${c.open.toFixed(3)} H:${c.high.toFixed(3)} L:${c.low.toFixed(3)} C:${c.close.toFixed(3)} → ${signal} ${decision && decision.setup ? '('+decision.setup+')' : ''} | emaTrend=${ind.emaTrend} rsi=${ind.rsi.toFixed(1)} ema20=${ind.ema20.toFixed(3)} ema50=${ind.ema50.toFixed(3)} atr=${ind.atr.toFixed(3)}`);
    }
  }
})();
