#!/usr/bin/env bash
# Faz 1 dahil CPU tahtalar için CUDA gerektirmeyen kurulum.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null; then
  command -v curl >/dev/null || { echo "uv kurulumu için curl gerekli."; exit 1; }
  echo "uv kuruluyor..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="${HOME}/.local/bin:${PATH}"
fi

uv python install 3.12
uv venv --python 3.12 .venv
GPU_PACKAGES=()
if command -v nvidia-smi >/dev/null; then
  GPU_PACKAGES=(nvidia-cublas-cu12 nvidia-cudnn-cu12)
  echo "NVIDIA GPU bulundu; CUDA çalışma kitaplıkları da kurulacak."
else
  echo "NVIDIA GPU bulunamadı; hafif CPU kurulumu seçildi."
fi
uv pip install --python .venv/bin/python \
  faster-whisper fastapi "uvicorn[standard]" numpy pynput "${GPU_PACKAGES[@]}"

chmod +x run.sh
echo
echo "Kuruldu. CPU uyumlu küçük Türkçe çok dilli model ilk açılışta indirilir. Başlatmak için: ./run.sh"
