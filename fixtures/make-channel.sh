#!/usr/bin/env sh
# Generates a synthetic fixture channel at tests/fixtures/channel-A.
# All names are synthetic (t-fixture*, alpha, bravo, fixture-box) — never real
# roster names or task ids. Safe to re-run: wipes and regenerates the dir.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/channel-A"

rm -rf "$ROOT"
mkdir -p "$ROOT/tasks/t-fixture1" "$ROOT/tasks/t-fixture2"

# t-fixture1: full happy path ending accepted (agent alpha)
cat >"$ROOT/tasks/t-fixture1/order.json" <<'EOF'
{ "agent": "alpha", "machine": "fixture-box", "title": "draw the synthetic duck" }
EOF
cat >"$ROOT/tasks/t-fixture1/claim.json" <<'EOF'
{ "agent": "alpha", "machine": "fixture-box" }
EOF
cat >"$ROOT/tasks/t-fixture1/result.json" <<'EOF'
{ "agent": "alpha", "machine": "fixture-box", "ok": true }
EOF
cat >"$ROOT/tasks/t-fixture1/review.json" <<'EOF'
{ "agent": "alpha", "reviewer": "bravo", "verdict": "accepted", "machine": "fixture-box" }
EOF

# t-fixture2: full lifecycle ending rejected/rework (agent bravo)
cat >"$ROOT/tasks/t-fixture2/order.json" <<'EOF'
{ "agent": "bravo", "machine": "fixture-box", "title": "polish the synthetic pond" }
EOF
cat >"$ROOT/tasks/t-fixture2/claim-01.marker" <<'EOF'
{ "agent": "bravo", "machine": "fixture-box" }
EOF
printf '{ "agent": "bravo", "ok": false }\n' >"$ROOT/tasks/t-fixture2/result.json"
printf '{ "reviewer": "alpha", "verdict": "rejected" }\n' >"$ROOT/tasks/t-fixture2/review.json"

echo "wrote $ROOT"
