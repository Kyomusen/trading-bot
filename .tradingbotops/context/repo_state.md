# Repo State — trading-bot

- Repo: https://github.com/Kyomusen/trading-bot
- Branch: main
- Last known commit: (fill in on next sync)

## Structure
- backtest/ — audit.js, runBacktest.js, validate.js
- broker/ — brokerSimulator.js, capitalClient.js, capitalStream.js, spreadHelper.js
- engine/ — positionManager.js, positionTracker.js, tradeEvent.js
- live/ — candleRecorder.js, runLive.js
- notify/ — chart.js, discord/
- scripts/ — convertData.js, dryRunLive.js, offsetTest.js, verifyLiveMatchesBacktest.js, verifyRecordedLiveVsBacktest.js
- signals/ — exampleStrategy.js, index.js, xauStrategy.js
- sizing/ — confidenceBased.js, fixedRisk.js, index.js, legacyMaxLot.js
- utils/ — indicators.js
- config.js, index.js
