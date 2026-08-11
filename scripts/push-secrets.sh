#!/usr/bin/env bash
# Push every KEY=VALUE pair from .dev.vars to Cloudflare Workers as a secret.
# Skips blank lines, comments, and empty values. Safe to re-run after rotating.

set -euo pipefail

VARS_FILE=".dev.vars"
[[ -f "$VARS_FILE" ]] || { echo "Error: $VARS_FILE not found" >&2; exit 1; }

count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  if [[ -z "$value" ]]; then
    echo "  skip $key (empty)"
    continue
  fi

  echo "→ pushing $key"
  printf '%s' "$value" | npx wrangler secret put "$key"
  count=$((count + 1))
done < "$VARS_FILE"

echo "Done. Pushed $count secret(s)."
