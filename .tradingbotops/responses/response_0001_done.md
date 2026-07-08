# Task 0001 — Response

Task ID: 0001

## Summary
Fixed risk reporting in `live/runLive.js` `maybeOpen()` to use the broker-filled `actualSize` (the real size after margin clamp) instead of the pre-clamp `size`:
- `riskAmount` passed to `createTradeEvent` is now `Math.min(riskAmt, actualSize * slDist)` (was `size * slDist`).
- The `[live] OPEN ...` console.log now prints `actualSize` instead of `size`.
- Confirmed `logTrade({ type: 'OPEN', ... })` already uses `actualSize` for its `size` field — left unchanged.

## Files touched
- `live/runLive.js` (2 lines changed; no other logic touched)

## Commit
9ed575b6c5b36217cd4ace6ac12dc39f49356e8b

## Problems / ambiguities / deviations
- None. Minimal diff only, `node --check live/runLive.js` passes. No changes to sizing/broker/calcPositionSize/resolveMaxLot or anything outside `live/runLive.js`.
