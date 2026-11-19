#!/usr/bin/env bash
# Build the Rust core and drop it where Vite can hash it as an asset.
set -euo pipefail
cd "$(dirname "$0")/.."
# simd128 is what lets the solver's flat loops vectorise; every browser that
# has WebGL2 has had it for years.
RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --release --manifest-path wasm/Cargo.toml --target wasm32-unknown-unknown
OUT=wasm/target/wasm32-unknown-unknown/release/fire_core.wasm
DEST=src/sim/fire-core.wasm

# wasm-opt is a nice-to-have, not a build dependency.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-simd "$OUT" -o "$DEST"
  echo "built + optimised: $(du -h "$DEST" | cut -f1)"
else
  cp "$OUT" "$DEST"
  echo "built: $(du -h "$DEST" | cut -f1)  (install wasm-opt via binaryen for a smaller binary)"
fi
