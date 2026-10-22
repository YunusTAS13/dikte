#!/usr/bin/env bash
# GitHub Pages için statik arayüzü docs/ klasörüne hazırla.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf docs
mkdir -p docs
cp static/* docs/
sed -i 's|/static/style.css|./style.css|g; s|/static/app.js|./app.js|g' docs/index.html
sed -i 's|/static/pcm-worklet.js|./pcm-worklet.js|g' docs/app.js
touch docs/.nojekyll
echo "GitHub Pages arayüzü docs/ klasörüne hazırlandı."
