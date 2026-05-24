#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-/root/.openclaw/workspace}"
QUERY="${2:-向量记忆系统现在是什么状态？}"
LIMIT="${3:-8}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$OUT_DIR/../.." && pwd)"
SLUG="$(printf '%s' "$QUERY" | sha1sum | awk '{print $1}' | cut -c1-12)"
OUT_FILE="$OUT_DIR/data-$SLUG.json"
LATEST_FILE="$OUT_DIR/data.json"

cd "$REPO_DIR"

run_panel() {
  node packages/cli/dist/index.js panel \
    --root "$ROOT_DIR" \
    --json \
    --limit "$LIMIT" \
    --query "$QUERY"
}

if [ -f .env ]; then
  # shellcheck disable=SC2046
  env $(grep -v '^#' .env | xargs) bash -lc "$(declare -f run_panel); run_panel" > "$OUT_FILE"
else
  run_panel > "$OUT_FILE"
fi

cp "$OUT_FILE" "$LATEST_FILE"

INDEX_FILE="$OUT_DIR/queries.json"
python3 - "$INDEX_FILE" "$QUERY" "$SLUG" <<'PY'
import json, sys, os
path, query, slug = sys.argv[1:4]
obj = {"queries": []}
if os.path.exists(path):
    with open(path, 'r', encoding='utf-8') as f:
        obj = json.load(f)
queries = [q for q in obj.get('queries', []) if q.get('slug') != slug and q.get('query') != query]
queries.insert(0, {"query": query, "slug": slug, "file": f"data-{slug}.json"})
obj['queries'] = queries[:20]
with open(path, 'w', encoding='utf-8') as f:
    json.dump(obj, f, ensure_ascii=False, indent=2)
PY

echo "wrote $OUT_FILE"
echo "updated $LATEST_FILE"
echo "updated $INDEX_FILE"
