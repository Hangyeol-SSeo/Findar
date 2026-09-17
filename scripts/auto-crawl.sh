#!/bin/bash
# auto-crawl.sh — Findar 자동 크롤링 스크립트
# 영업일 다음날(화~토) 새벽에 실행: KOFIA 채용공고 5페이지(50건) 수집 + AI 분석

set -euo pipefail

PROJECT_DIR="/Users/samryong/Documents/Findar"
LOG_DIR="$PROJECT_DIR/data"
LOG_FILE="$LOG_DIR/auto-crawl.log"
PORT=3000
MAX_WAIT_SECS=120   # 서버 기동 대기 최대 시간
MAX_CRAWL_SECS=3600 # 크롤링 최대 대기 시간 (1시간)

mkdir -p "$LOG_DIR"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG_FILE"
}

log "========================================"
log "Findar 자동 크롤링 시작"

# 서버가 이미 실행 중인지 확인
SERVER_STARTED=false
if lsof -i :"$PORT" -sTCP:LISTEN -t > /dev/null 2>&1; then
  log "포트 $PORT 이미 사용 중 → 기존 서버 활용"
else
  log "Next.js 서버 기동 중 (port $PORT)..."
  cd "$PROJECT_DIR"
  npm run dev -- -p "$PORT" > /tmp/findar-dev-server.log 2>&1 &
  SERVER_PID=$!
  SERVER_STARTED=true
  log "서버 PID: $SERVER_PID"

  # 서버 준비 대기
  log "서버 응답 대기 중 (최대 ${MAX_WAIT_SECS}초)..."
  ELAPSED=0
  READY=false
  while [ $ELAPSED -lt $MAX_WAIT_SECS ]; do
    sleep 3
    ELAPSED=$((ELAPSED + 3))
    if curl -sf "http://localhost:$PORT/" > /dev/null 2>&1; then
      READY=true
      log "서버 준비 완료 (${ELAPSED}초 소요)"
      break
    fi
  done

  if [ "$READY" = false ]; then
    log "오류: 서버가 ${MAX_WAIT_SECS}초 내 기동되지 않음"
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
fi

# /api/jobs 호출 (SSE 스트림)
log "공고 수집 시작 (5페이지 / 최대 50건)..."
TMPFILE=$(mktemp)

HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" \
  --no-buffer \
  --max-time "$MAX_CRAWL_SECS" \
  "http://localhost:$PORT/api/jobs?pages=5" 2>&1) || true

log "HTTP 응답 코드: $HTTP_CODE"

# done 이벤트에서 신규 건수 추출
if grep -q '"type":"done"' "$TMPFILE"; then
  NEW_COUNT=$(grep '"type":"done"' "$TMPFILE" | grep -o '"newCount":[0-9]*' | grep -o '[0-9]*' | tail -1)
  log "크롤링 완료: 신규 공고 ${NEW_COUNT:-0}건 수집·분석"
else
  log "경고: done 이벤트 없음 (스트림이 중간에 끊겼을 수 있음)"
  # 에러 메시지가 있으면 기록
  grep '"type":"error"' "$TMPFILE" | head -3 >> "$LOG_FILE" || true
fi

rm -f "$TMPFILE"

# 우리가 기동한 서버만 종료
if [ "$SERVER_STARTED" = true ]; then
  log "서버 종료 중 (PID $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  # 자식 프로세스도 정리
  sleep 2
  pkill -P "$SERVER_PID" 2>/dev/null || true
  log "서버 종료 완료"
fi

log "Findar 자동 크롤링 완료"
log "========================================"
