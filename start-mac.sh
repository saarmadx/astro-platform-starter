#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then echo "Installing, this takes a few minutes the first time..."; npm install; fi
(sleep 10; open http://localhost:4321/studio) &
npm run dev
