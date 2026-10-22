#!/usr/bin/env bash
# Disables every workflow inherited from upstream in this fork, keeping only
# the pt-BR overlay workflows. Runs on every pipeline execution because new
# upstream workflow files are registered (and enabled) when GitHub first sees them.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${GH_TOKEN:?}"
allow='^\.github/workflows/ptbr(-ci)?\.yml$'
gh api "repos/$GITHUB_REPOSITORY/actions/workflows" --paginate \
  --jq '.workflows[] | select(.state=="active") | "\(.id)\t\(.path)"' |
while IFS=$'\t' read -r id wf_path; do
  if [[ "$wf_path" =~ $allow || "$wf_path" == dynamic/* ]]; then continue; fi
  gh api -X PUT "repos/$GITHUB_REPOSITORY/actions/workflows/$id/disable" >/dev/null
  echo "disabled inherited workflow: $wf_path"
done
