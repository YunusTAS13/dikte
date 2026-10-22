#!/usr/bin/env bash
# Dikte sunucusunu durdurur
set -euo pipefail
PORT="${DIKTE_PORT:-8765}"
if command -v fuser >/dev/null; then
  fuser -k "${PORT}/tcp" 2>/dev/null && echo "Dikte durduruldu." || echo "Çalışan Dikte yok."
else
  pkill -f "python server.py" && echo "Dikte durduruldu." || echo "Çalışan Dikte yok."
fi
