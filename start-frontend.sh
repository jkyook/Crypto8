#!/bin/bash
# Crypto8 프론트엔드 개발 서버 시작 스크립트
cd "$(dirname "$0")"
echo "▶ 프론트엔드 서버 시작 중... (http://localhost:5173)"
npx vite
