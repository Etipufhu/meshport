#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Please install Node.js 18+ from https://nodejs.org"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies, this happens only once..."
  npm install --no-audit --no-fund
fi

npm start
