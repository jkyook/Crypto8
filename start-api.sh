#!/bin/bash
# Crypto8 API 서버 시작 스크립트
cd "$(dirname "$0")"
echo "▶ API 서버 시작 중... (http://localhost:8787)"
npx tsx server/index.ts
