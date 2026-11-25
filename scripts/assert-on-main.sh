#!/usr/bin/env bash
set -euo pipefail

sha="${1:-${GITHUB_SHA:-HEAD}}"
main_ref="${2:-origin/main}"

if ! git merge-base --is-ancestor "$sha" "$main_ref"; then
  echo "::error::Tagged commit $sha is not on main; refusing to publish."
  exit 1
fi
