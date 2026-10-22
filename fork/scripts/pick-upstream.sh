#!/usr/bin/env bash
# Prints up_sha=<sha> and up7=<short> for the newest upstream main commit that
# (1) has an official image ghcr.io/elie222/inbox-zero:<sha7> and
# (2) passed upstream's "build" check (type-checked Next build), or had none.
# Usage: pick-upstream.sh [explicit-ref]
set -euo pipefail
: "${UPSTREAM:=elie222/inbox-zero}" "${UPSTREAM_IMAGE:=ghcr.io/elie222/inbox-zero}"
ref="${1:-}"
if [[ -n "$ref" ]]; then
  shas=$(gh api "repos/$UPSTREAM/commits/$ref" --jq .sha)
else
  shas=$(gh api "repos/$UPSTREAM/commits?sha=main&per_page=30" --jq '.[].sha')
fi
for s in $shas; do
  short="${s:0:7}"
  if ! docker buildx imagetools inspect "$UPSTREAM_IMAGE:$short" >/dev/null 2>&1; then
    echo "skip $short: no official image" >&2; continue
  fi
  ok=$(gh api "repos/$UPSTREAM/commits/$s/check-runs?check_name=build&per_page=20" \
        --jq '[.check_runs[] | select(.app.slug=="github-actions") | .conclusion] | all(. == "success")')
  if [[ "$ok" != "true" ]]; then echo "skip $short: upstream build check not green" >&2; continue; fi
  echo "up_sha=$s"
  echo "up7=$short"
  exit 0
done
echo "no eligible upstream commit among the candidates" >&2
exit 1
