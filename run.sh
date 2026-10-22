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
  READY=0
  for _ in $(seq 1 600); do
    if curl -sf "${LOCAL_URL}/api/status" >/dev/null 2>&1; then
      echo " — hazır."
      READY=1
      break
    fi
    if ! kill -0 "$(cat .dikte.pid)" 2>/dev/null; then
      printf "\nDikte sunucusu başlayamadı. Hata için doğrudan şu komutu çalıştır:\n"
      echo "HF_HUB_DISABLE_IMPLICIT_TOKEN=1 .venv/bin/python server.py"
      exit 1
    fi
    printf "."
    sleep 0.5
  done
  if [ "$READY" -ne 1 ]; then
    printf "\nSunucu 5 dakika içinde hazır olmadı. Model indirmesi sürüyor olabilir; /api/status adresini kontrol et.\n"
    exit 1
  fi
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
