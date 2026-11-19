#!/usr/bin/env bash
# Build the Rust core and drop it where Vite can hash it as an asset.
set -euo pipefail
cd "$(dirname "$0")/../wasm"
cargo build --release
OUT=target/wasm32-unknown-unknown/release/oil_core.wasm
DEST=../src/sim/oil-core.wasm

# wasm-opt is a nice-to-have, not a build dependency.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-simd "$OUT" -o "$DEST"
  echo "built + optimised: $(du -h "$DEST" | cut -f1)"
else
  cp "$OUT" "$DEST"
  echo "built: $(du -h "$DEST" | cut -f1)  (install wasm-opt via binaryen for a smaller binary)"
fi
