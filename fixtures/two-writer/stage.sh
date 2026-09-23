#!/bin/sh
# Stage one fresh copy of the two-writer fixture under the system temp dir:
# base committed, half-fix applied uncommitted, payload rendered with the root
# into "$ROOT.payload.md" — beside the project, never inside it.
# Prints the staged root. The fixture itself is never modified.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/two-writer.XXXXXX")
cp -R "$HERE/base/." "$ROOT/"
cd "$ROOT"
git init -q && git add -A && git -c user.name=fixture -c user.email=fixture@local commit -qm base
patch -s -p1 < "$HERE/half-fix.diff"
sed "s#{{ROOT}}#$ROOT#" "$HERE/payload.md" > "$ROOT.payload.md"
echo "$ROOT"
