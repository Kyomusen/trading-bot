#!/bin/bash
# Start streaming bot for XAUUSD
cd "$(dirname "$0")"
nohup node --no-warnings core/runner.js stream XAUUSD >> logs/stream.log 2>&1 &
echo $! > logs/stream.pid
echo "Streaming bot started (PID: $(cat logs/stream.pid))"
