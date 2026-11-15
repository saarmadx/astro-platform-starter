#!/bin/bash
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo ""
  echo "CLIPSMITH - FIRST TIME SETUP"
  okey=""; while [ -z "$okey" ]; do read -r -p "1) Paste your OpenAI key (starts with sk-) and press Enter: " okey; done
  akey=""; while [ -z "$akey" ]; do read -r -p "2) Paste your Anthropic key (starts with sk-ant-) and press Enter: " akey; done
  printf 'OPENAI_API_KEY=%s\nANTHROPIC_API_KEY=%s\nAPP_ACCESS_CODE=\n' "$okey" "$akey" > .env
  echo "Keys saved. To change them later, delete the .env file and run this again."
fi
if [ ! -d node_modules ]; then echo "Installing, this takes a few minutes the first time..."; npm install; fi
(sleep 10; open http://localhost:4321/studio) &
npm run dev
