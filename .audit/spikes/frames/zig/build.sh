#!/bin/sh
# Throwaway. nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#zig --command sh build.sh
cd "$(dirname "$0")" && zig version && zig build-exe core.zig -target wasm32-freestanding -O "${1:-ReleaseFast}" -fstrip -fno-entry -rdynamic --cache-dir "${TMPDIR:-/tmp}/zig-spike" -femit-bin=core.wasm && wc -c core.wasm && gzip -9c core.wasm | wc -c
