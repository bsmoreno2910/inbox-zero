#!/usr/bin/env bash
# Usage: tsc-errors.sh <out-file>   (run from src/apps/web)
# Writes the type errors as sorted "file TScode" lines, one per error.
# The message text is dropped on purpose: tsc prints types (union order, truncated
# property lists) differently when the check order changes, so an untouched file's
# error can read differently between two runs over almost the same tree.
set -euo pipefail
out="$1"
raw="$out.raw"

set +e
pnpm exec tsc --noEmit -p tsconfig.json > "$raw" 2>&1
rc=$?
set -e

if [[ $rc -ne 0 ]] && ! grep -q 'error TS' "$raw"; then
  echo "::error::tsc did not run (exit $rc)"
  tail -20 "$raw"
  exit 1
fi

sed -nE 's/^([^:]+)\([0-9]+,[0-9]+\): error (TS[0-9]+):.*/\1 \2/p' "$raw" | LC_ALL=C sort > "$out"
echo "$(wc -l < "$out") type errors"
