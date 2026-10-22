#!/usr/bin/env bash
# Counts Prisma migrations added upstream between the SHA running in production
# (label on :stable) and the new SHA. Prints "count=<n>". Fails when there are new
# migrations unless ALLOW_MIGRATIONS=true (a manual dispatch with deploy=true sets it).
set -euo pipefail
: "${IMAGE:?}" "${UPSTREAM:=elie222/inbox-zero}"
new_sha="${1:?usage: migration-gate.sh <new-upstream-sha>}"
old_sha=$(docker buildx imagetools inspect "$IMAGE:stable" --format '{{ index .Image.Config.Labels "io.inboxzero.upstream.revision" }}' 2>/dev/null || true)
if [[ -z "$old_sha" ]]; then echo "count=unknown"; echo "no :stable yet; first deploy" >&2; exit 0; fi
count=$(gh api "repos/$UPSTREAM/compare/$old_sha...$new_sha" --paginate \
  --jq '[.files[]? | select(.filename | test("^apps/web/prisma/migrations/.*/migration\\.sql$"))] | length' |
  awk '{ s += $1 } END { print s + 0 }')
echo "count=$count"
if [[ "$count" != "0" && "${ALLOW_MIGRATIONS:-false}" != "true" ]]; then
  echo "::error::$count new database migrations between ${old_sha:0:7} and ${new_sha:0:7}. Back up inbox-zero-db in Easypanel, then run the workflow manually with deploy=true."
  exit 1
fi
