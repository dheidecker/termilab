#!/usr/bin/env bash
# Full verification of termilab-keeper on this machine (x86_64 Linux):
#   1. build all arches twice -> identical sha256 (reproducible)
#   2. every binary is static; the x86_64 one runs here
#   3. functional tests (keeper_test.py) against the release x86_64 binary
#   4. the same tests against an ASan+UBSan build; any sanitizer report fails
#   5. random-input fuzz of the frame parser and escape scanner (FUZZ_SECS, default 60)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KDIR="$(dirname "$HERE")"
ROOT="$(cd "$KDIR/../.." && pwd)"
KV="$(sed -n 's/^#define KEEPER_VERSION \([0-9][0-9]*\).*/\1/p' "$KDIR/src/keeper.h")"
WORK="$(mktemp -d /tmp/keeper-tests.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
FUZZ_SECS="${FUZZ_SECS:-60}"
fail=0
step() { printf '\n== %s\n' "$*"; }

step "reproducible build"
"$ROOT/scripts/build-keeper.sh" >/dev/null
cp "$KDIR/manifest.json" "$WORK/manifest.1"
"$ROOT/scripts/build-keeper.sh" >/dev/null
if cmp -s "$WORK/manifest.1" "$KDIR/manifest.json"; then
  echo "PASS two builds give identical sha256:"
  sed -n 's/.*"\([a-z0-9_]*\)": {"file": "\([^"]*\)", "sha256": "\([0-9a-f]\{16\}\).*"size": \([0-9]*\).*/  \1 \4 bytes sha256 \3.../p' "$KDIR/manifest.json"
else
  echo "FAIL builds differ"; diff "$WORK/manifest.1" "$KDIR/manifest.json" || true; fail=1
fi

step "static binaries"
for f in "$KDIR"/bin/termilab-keeper-"$KV"-*; do
  desc="$(file -b "$f")"
  if [[ "$desc" == *"statically linked"* ]]; then echo "PASS $(basename "$f"): ${desc%%, version*}, static"
  else echo "FAIL $(basename "$f"): $desc"; fail=1; fi
done
BIN="$KDIR/bin/termilab-keeper-$KV-x86_64"
if out="$("$BIN" version)"; then echo "PASS x86_64 runs here: $out"; else echo "FAIL x86_64 does not run"; fail=1; fi

step "functional tests (release x86_64)"
python3 "$HERE/keeper_test.py" "$BIN" || fail=1

# Separate ASan and UBSan builds: daemons have stderr on /dev/null, and only
# the standalone UBSan runtime honours UBSAN_OPTIONS=log_path.
SAN=(-O1 -g -fno-omit-frame-pointer -fno-sanitize-recover=all -Wall -Wextra)
mkdir -p "$WORK/san"
export ASAN_OPTIONS="log_path=$WORK/san/asan:detect_leaks=1:abort_on_error=1:detect_stack_use_after_return=1"
export UBSAN_OPTIONS="log_path=$WORK/san/ubsan:print_stacktrace=1:halt_on_error=1"
for s in address undefined; do
  step "functional tests (-fsanitize=$s)"
  gcc "${SAN[@]}" -fsanitize="$s" -o "$WORK/keeper-$s" "$KDIR"/src/*.c
  python3 "$HERE/keeper_test.py" "$WORK/keeper-$s" || fail=1
  if compgen -G "$WORK/san/*" >/dev/null; then
    echo "FAIL sanitizer reports:"; head -50 "$WORK"/san/*; fail=1
  else
    echo "PASS no -fsanitize=$s reports from clients or daemons"
  fi
done

step "fuzz (${FUZZ_SECS}s, ASan + UBSan)"
gcc "${SAN[@]}" -fsanitize=address,undefined -o "$WORK/fuzz" "$HERE/fuzz.c" "$KDIR"/src/{util,scan,ring,paths}.c
if "$WORK/fuzz" "$FUZZ_SECS" "${FUZZ_SEED:-$RANDOM}" && ! compgen -G "$WORK/san/*" >/dev/null; then
  echo "PASS fuzz clean"
else
  echo "FAIL fuzz"; head -50 "$WORK"/san/* 2>/dev/null || true; fail=1
fi

step "result"
if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"
