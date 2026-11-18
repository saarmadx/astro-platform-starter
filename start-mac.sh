#!/bin/bash
cd "$(dirname "$0")"
echo "Checking what Clipsmith needs (a few minutes the first time)..."
npm install --no-audit --no-fund || { echo "Installing failed. Check your internet connection and try again."; exit 1; }
(sleep 10; open http://localhost:4321/studio) &
npm run dev
