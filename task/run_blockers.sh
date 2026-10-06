#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
canonical="$root/task/tests/canvas-push-recovery.test.ts"
target="$root/packages/cli/test/canvas-push-recovery.test.ts"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/contour-blockers.XXXXXX")
had_target=0

cleanup() {
  if [ "$had_target" -eq 1 ]; then
    cp "$temporary/original.test.ts" "$target"
  else
    rm -f "$target"
  fi
  rm -rf "$temporary"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -e "$target" ]; then
  cp "$target" "$temporary/original.test.ts"
  had_target=1
fi

cp "$canonical" "$target"

if command -v pnpm >/dev/null 2>&1; then
  pnpm --dir "$root/packages/schema" run build
  pnpm --dir "$root/packages/renderer" run build
  pnpm --dir "$root/packages/cli" run build

  pnpm --dir "$root/packages/cli" exec vitest run \
    test/canvas-push-recovery.test.ts \
    --reporter=verbose \
    --maxWorkers=1 \
    --minWorkers=1 \
    --testNamePattern='^blocker [123]:'
else
  npm --prefix "$root/packages/schema" run build
  npm --prefix "$root/packages/renderer" run build
  npm --prefix "$root/packages/cli" run build

  npm --prefix "$root/packages/cli" exec -- vitest run \
    test/canvas-push-recovery.test.ts \
    --reporter=verbose \
    --maxWorkers=1 \
    --minWorkers=1 \
    --testNamePattern='^blocker [123]:'
fi