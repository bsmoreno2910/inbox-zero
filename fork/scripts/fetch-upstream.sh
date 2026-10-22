#!/usr/bin/env bash
# Shallow, credential-free checkout of one upstream commit.
# actions/checkout fails on upstream because apps/web/app/(marketing) is a
# gitlink to a private repo with no .gitmodules entry, so plain git is used.
# Usage: fetch-upstream.sh <sha-or-ref> <dir>
set -euo pipefail
ref="${1:?ref}"; dir="${2:?dir}"; repo="https://github.com/${UPSTREAM:-elie222/inbox-zero}.git"
rm -rf "$dir"; git init -q "$dir"
git -C "$dir" -c protocol.version=2 fetch -q --depth 1 --no-recurse-submodules "$repo" "$ref"
git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
git -C "$dir" log -1 --format='upstream %h %cs %s'
