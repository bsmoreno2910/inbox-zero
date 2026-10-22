#!/usr/bin/env bash
# Usage: easypanel-deploy.sh   (env: DEPLOY_WEBHOOK, PANEL_URL)
# Triggers the Easypanel deploy webhook. Only the token is taken from the secret:
# the URL Easypanel displays can use the server's own address (IP:3000), which
# GitHub cannot reach, so the call always goes to the panel's public URL.
# Nothing about the URL is printed: this repository's logs are public.
set -euo pipefail
: "${PANEL_URL:?set the PTBR_PANEL_URL variable, e.g. https://vtc.srv.br}"
webhook=$(printf '%s' "${DEPLOY_WEBHOOK:-}" | tr -d '[:space:]')

if [[ "$webhook" == */api/deploy/* ]]; then
  token="${webhook##*/api/deploy/}"
  token="${token%%[?#]*}"
  token="${token%/}"
  echo "::add-mask::$token"
  url="${PANEL_URL%/}/api/deploy/$token"
else
  url="$webhook"
fi

code=$(curl -s --connect-timeout 15 --max-time 60 --retry 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null) || code=000
case "$code" in
  2*) echo "Easypanel deploy triggered (HTTP $code)" ;;
  000) echo "::error::Could not connect to the Easypanel panel ($PANEL_URL)."; exit 1 ;;
  404) echo "::error::Easypanel rejected the deploy token (HTTP 404). Copy the deploy webhook again into PTBR_EASYPANEL_DEPLOY_WEBHOOK."; exit 1 ;;
  *) echo "::error::Easypanel deploy webhook returned HTTP $code."; exit 1 ;;
esac
