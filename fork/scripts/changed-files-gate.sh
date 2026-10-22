#!/usr/bin/env bash
# The transform may only touch .ts/.tsx files plus the generated runtime file.
# Anything else (package.json, lockfile, Dockerfile...) fails the build.
set -euo pipefail
src="${1:?usage: changed-files-gate.sh <upstream-checkout>}"
bad=$(git -C "$src" status --porcelain -uall | awk '{print $2}' |
  grep -vE '\.(ts|tsx)$' | grep -vE '^apps/web/__ptbr__/runtime\.ts$' || true)
if [[ -n "$bad" ]]; then
  echo "::error::transform changed files outside the allowlist:"; echo "$bad"; exit 1
fi
echo "changed files: $(git -C "$src" status --porcelain -uall | wc -l) (all .ts/.tsx)"
