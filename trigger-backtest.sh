#!/bin/bash
cd /mnt/sdcard/_code
while true; do
  dow=$(date +%u)
  hour=$(date +%H)
  if [ "$dow" = "1" ] && [ "$hour" = "06" ]; then
    echo "[$(date)] Triggering weekly backtest..." >> /tmp/cron.log
    gh workflow run Backtest >> /tmp/cron.log 2>&1
    echo "[$(date)] Sleeping 23h to avoid re-trigger..." >> /tmp/cron.log
    sleep 82800
  fi
  sleep 3600
done
