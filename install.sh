#!/usr/bin/env bash
# Sıfırdan kurulum: Python 3.12 + faster-whisper + CUDA kütüphaneleri
set -euo pipefail
cd "$(dirname "$0")"

command -v uv >/dev/null || { echo "uv gerekli: https://docs.astral.sh/uv/"; exit 1; }

uv python install 3.12
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python \
  faster-whisper fastapi "uvicorn[standard]" numpy \
  nvidia-cublas-cu12 nvidia-cudnn-cu12 pynput

chmod +x run.sh
echo
echo "Kuruldu. Başlatmak için: ./run.sh"
