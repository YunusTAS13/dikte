#!/usr/bin/env bash
# Dikte'yi başlatır: sunucu + tarayıcı
set -euo pipefail
cd "$(dirname "$0")"

PORT="${DIKTE_PORT:-8765}"
HOST="${DIKTE_HOST:-127.0.0.1}"
LOCAL_URL="http://127.0.0.1:${PORT}"

if [ ! -x .venv/bin/python ]; then
  echo "Sanal ortam yok. Kurulum için: ./install.sh"
  exit 1
fi

# Sunucu zaten açıksa tekrar başlatma
if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  echo "Dikte zaten çalışıyor: ${LOCAL_URL}"
else
  HF_HUB_DISABLE_IMPLICIT_TOKEN=1 .venv/bin/python server.py &
  echo $! > .dikte.pid
  printf "Model yükleniyor"
  for _ in $(seq 1 120); do
    if curl -sf "${LOCAL_URL}/api/status" >/dev/null 2>&1; then
      echo " — hazır."
      break
    fi
    printf "."
    sleep 0.5
  done
fi

if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
  xdg-open "$LOCAL_URL" >/dev/null 2>&1 || echo "Tarayıcıda aç: ${LOCAL_URL}"
else
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$LAN_IP" ]; then
    echo "Dikte ${HOST}:${PORT} üzerinde dinliyor. Aynı ağdaki istemcide http://${LAN_IP}:${PORT} adresini açın."
  else
    echo "Dikte ${HOST}:${PORT} üzerinde dinliyor. Sunucunun ağ IP'sini bulun ve istemcide http://SUNUCU_IP:${PORT} adresini açın."
  fi
fi
