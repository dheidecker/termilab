#!/usr/bin/env bash
# Builds the static termilab-keeper binaries for every supported server arch
# with Zig as the C cross-compiler, and writes electron/keeper/manifest.json.
# Reproducible: same sources + same Zig version -> byte-identical binaries.
#   ZIG=/path/to/zig scripts/build-keeper.sh      (default: ~/opt/zig/zig, then PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KDIR="$ROOT/electron/keeper"
ZIG="${ZIG:-$HOME/opt/zig/zig}"
[ -x "$ZIG" ] || ZIG="$(command -v zig || true)"
[ -n "$ZIG" ] || { echo "zig not found (set ZIG=...)" >&2; exit 1; }

# Pinned: another Zig (another bundled musl/clang) gives other bytes, and the
# sha256 in manifest.json would change with no source change. Checked by
# scripts/lib/check-keeper-files.js. Bump on purpose, together with a rebuild.
ZIG_VERSION="0.16.0"
got="$("$ZIG" version)"
[ "$got" = "$ZIG_VERSION" ] || { echo "zig $got at $ZIG, need $ZIG_VERSION (pinned)" >&2; exit 1; }

KV="$(sed -n 's/^#define KEEPER_VERSION \([0-9][0-9]*\).*/\1/p' "$KDIR/src/keeper.h")"
[ -n "$KV" ] || { echo "KEEPER_VERSION not found in keeper.h" >&2; exit 1; }

# key = `uname -m` on the server : zig target : cpu baseline
TARGETS=(
  "x86_64:x86_64-linux-musl:baseline"
  "aarch64:aarch64-linux-musl:baseline"
  "armv7l:arm-linux-musleabihf:generic+v7a"
  "riscv64:riscv64-linux-musl:baseline_rv64"
)

mkdir -p "$KDIR/bin"
rm -f "$KDIR"/bin/termilab-keeper-*

entries=()
cd "$KDIR/src"
for t in "${TARGETS[@]}"; do
  IFS=: read -r arch target cpu <<<"$t"
  out="termilab-keeper-$KV-$arch"
  "$ZIG" cc -target "$target" -mcpu="$cpu" -std=c11 -Os -static -s \
    -Wall -Wextra -Werror -fno-ident \
    -ffile-prefix-map="$KDIR"=. -ffile-prefix-map="$ROOT"=. \
    -o "$KDIR/bin/$out" client.c daemon.c paths.c ring.c scan.c util.c
  sha="$(sha256sum "$KDIR/bin/$out" | cut -d' ' -f1)"
  size="$(stat -c %s "$KDIR/bin/$out")"
  entries+=("    \"$arch\": {\"file\": \"$out\", \"sha256\": \"$sha\", \"size\": $size}")
  echo "$out  $size  $sha"
done

{
  echo "{"
  echo "  \"kv\": $KV,"
  echo "  \"binaries\": {"
  last=$((${#entries[@]} - 1))
  for i in "${!entries[@]}"; do
    if [ "$i" -eq "$last" ]; then echo "${entries[$i]}"; else echo "${entries[$i]},"; fi
  done
  echo "  }"
  echo "}"
} > "$KDIR/manifest.json"
echo "wrote $KDIR/manifest.json"
