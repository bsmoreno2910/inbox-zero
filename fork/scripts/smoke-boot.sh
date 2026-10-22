#!/usr/bin/env bash
# Boots the candidate image against the job's service containers (postgres,
# redis, serverless-redis-http on the host network) and checks that the login
# page is rendered in Portuguese. Usage: smoke-boot.sh <image> <build-id> <sentinels.json>
set -euo pipefail
image="$1"; build_id="$2"; sentinels="$3"
name=ptbr-smoke
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --network host \
  -e NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
  -e DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
  -e DIRECT_URL=postgresql://postgres:postgres@localhost:5432/postgres \
  -e AUTH_SECRET=secret -e EMAIL_ENCRYPT_SECRET=secret -e EMAIL_ENCRYPT_SALT=salt \
  -e GOOGLE_CLIENT_ID=client_id -e GOOGLE_CLIENT_SECRET=client_secret -e GOOGLE_PUBSUB_TOPIC_NAME=topic \
  -e MICROSOFT_CLIENT_ID=client_id -e MICROSOFT_CLIENT_SECRET=client_secret \
  -e INTERNAL_API_KEY=secret -e DEFAULT_LLMS=openai-compatible:emulated \
  -e REDIS_HTTP_URL=http://localhost:8079 -e REDIS_HTTP_TOKEN=smoke-token \
  -e NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS=true -e NEXT_PUBLIC_EMAIL_SEND_ENABLED=true \
  -e HOSTNAME=0.0.0.0 \
  "$image" >/dev/null

ok=""
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]]; then break; fi
  sleep 3
done
docker logs "$name" > smoke-container.log 2>&1 || true
if [[ -z "$ok" ]]; then
  echo "::error::container did not become healthy"; tail -80 smoke-container.log; exit 1
fi

html=$(curl -fsS http://localhost:3000/login)
fail=0
grep -q 'lang="pt-BR"' <<<"$html" || { echo "::error::/login is missing lang=pt-BR"; fail=1; }
grep -q "data-ptbr-build=\"$build_id\"" <<<"$html" || { echo "::error::/login is missing data-ptbr-build=$build_id"; fail=1; }
while IFS= read -r s; do
  grep -qF "$s" <<<"$html" || { echo "::error::sentinel not found on /login: $s"; fail=1; }
done < <(node -e 'for (const s of require(process.argv[1]).login) console.log(s)' "$sentinels")
if grep -E -q 'Invalid environment variables|Minified React error #(418|423|425)|Hydration failed' smoke-container.log; then
  echo "::error::container log shows env/hydration errors"; grep -E 'Invalid environment|Minified React|Hydration' smoke-container.log | head; fail=1
fi
grep -E 'Database migrations' smoke-container.log || true
docker rm -f "$name" >/dev/null
exit "$fail"
