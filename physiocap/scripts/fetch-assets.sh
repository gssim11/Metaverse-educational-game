#!/usr/bin/env bash
# MediaPipe 런타임(WASM)과 포즈 모델을 web/vendor 에 내려받는다. 앱이 완전 오프라인으로 동작하도록 APK/PWA에 함께 묶인다.
set -euo pipefail
cd "$(dirname "$0")/.."
MP_VERSION="${MP_VERSION:-1.1.1}"
VENDOR=web/vendor
mkdir -p "$VENDOR/tasks-vision/wasm" "$VENDOR/models"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack "@mediapipe/tasks-vision@${MP_VERSION}" --silent >/dev/null && tar xzf ./*.tgz )
cp "$TMP/package/vision_bundle.mjs" "$VENDOR/tasks-vision/"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  cp "$TMP/package/wasm/$f" "$VENDOR/tasks-vision/wasm/"
done
echo "$MP_VERSION" > "$VENDOR/tasks-vision/VERSION"

BASE=https://storage.googleapis.com/mediapipe-models/pose_landmarker
for m in lite full; do
  out="$VENDOR/models/pose_landmarker_${m}.task"
  [ -s "$out" ] || curl -fsSL --retry 4 -o "$out" "$BASE/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task"
done
# heavy 모델(30MB)은 기본 미포함. INCLUDE_HEAVY=1 이면 같이 넣는다.
if [ "${INCLUDE_HEAVY:-0}" = "1" ]; then
  out="$VENDOR/models/pose_landmarker_heavy.task"
  [ -s "$out" ] || curl -fsSL --retry 4 -o "$out" "$BASE/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
fi
du -sh "$VENDOR"/*
