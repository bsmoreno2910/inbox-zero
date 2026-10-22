#!/usr/bin/env bash
# Frees ~25 GB on GitHub-hosted runners; the Next.js image build needs the room.
set -uo pipefail
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL || true
docker system prune -af >/dev/null 2>&1 || true
df -h / | tail -1
