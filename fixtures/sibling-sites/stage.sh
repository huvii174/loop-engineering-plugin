#!/bin/sh
# Stage one fresh copy of the sibling-sites fixture under the system temp dir.
#   stage.sh baseline|half|full
# baseline: goal without Sites:, half-fix applied  (the pre-check-9 verifier)
# half:     goal with Sites:,   half-fix applied   (check 9 must REJECT)
# full:     goal with Sites:,   full-fix applied   (check 9 must APPROVE)
# The diff is applied uncommitted; the payload is rendered into
# "$ROOT.payload.md", beside the project, never inside it. Prints the root.
# The caller deletes "$ROOT" and "$ROOT.payload.md" once evidence is saved.
set -e
VARIANT=${1:?usage: stage.sh baseline|half|full}
HERE=$(cd "$(dirname "$0")" && pwd)
case "$VARIANT" in
  baseline) GOAL="$HERE/base/.loop/goal.md";      DIFF="$HERE/variants/half-fix.diff" ;;
  half)     GOAL="$HERE/variants/goal.sites.md";  DIFF="$HERE/variants/half-fix.diff" ;;
  full)     GOAL="$HERE/variants/goal.sites.md";  DIFF="$HERE/variants/full-fix.diff" ;;
  *) echo "stage.sh: unknown variant $VARIANT" >&2; exit 2 ;;
esac
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/sibling-sites.XXXXXX")
echo "$ROOT" >&2   # surfaced before anything can fail, so a partial copy is findable
cp -R "$HERE/base/." "$ROOT/"
cp "$GOAL" "$ROOT/.loop/goal.md"
cd "$ROOT"
git init -q && git add -A && git -c user.name=fixture -c user.email=fixture@local commit -qm base
git apply "$DIFF"
ROOT="$ROOT" awk '{ gsub(/\{\{ROOT\}\}/, ENVIRON["ROOT"]) } 1' "$HERE/variants/payload.$VARIANT.md" > "$ROOT.payload.md"
echo "$ROOT"
