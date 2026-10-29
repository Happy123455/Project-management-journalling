#!/bin/sh
# Downloads the sherpa-onnx Android library used for Kokoro read-aloud (not committed: ~47 MB).
set -e
VERSION=1.13.8
DEST="$(dirname "$0")/../src-tauri/gen/android/app/libs/sherpa-onnx-$VERSION.aar"
[ -f "$DEST" ] && exit 0
mkdir -p "$(dirname "$DEST")"
curl -fL -o "$DEST" "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$VERSION/sherpa-onnx-$VERSION.aar"
