#!/usr/bin/env bash
#
# patch-openclaw.sh — let OpenClaw accept Obsidian's app:// origin.
#
# Why this exists:
#   Obsidian loads its renderer from app://obsidian.md. Per URL spec, custom
#   schemes have a "null" origin, so adding app://obsidian.md to
#   gateway.controlUi.allowedOrigins never matches and OpenClaw refuses the
#   websocket. This script adds one fallback check that compares the raw
#   origin string against the allowlist (in addition to the parsed origin).
#
# Safety:
#   - Idempotent. Safe to re-run.
#   - Writes a .obsidianclaw.bak alongside the patched file.
#   - Aborts if the OpenClaw source layout has shifted (no silent corruption).
#
# Note: OpenClaw upgrades wipe /usr/lib/node_modules/openclaw/dist, so this
# script needs to be re-run after every `openclaw update`. Track the upstream
# fix at https://github.com/openclaw/openclaw (search "opaque scheme origin").

set -euo pipefail

OPENCLAW_DIST="${OPENCLAW_DIST:-/usr/lib/node_modules/openclaw/dist}"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "❌ Not running as root and sudo is not available." >&2
    exit 1
  fi
fi

if [ ! -d "$OPENCLAW_DIST" ]; then
  echo "❌ OpenClaw dist directory not found at $OPENCLAW_DIST" >&2
  echo "   Set OPENCLAW_DIST to override." >&2
  exit 1
fi

AUTH_FILE=$($SUDO bash -c "grep -l 'checkBrowserOrigin' '$OPENCLAW_DIST'/auth-*.js 2>/dev/null | head -1" || true)
if [ -z "$AUTH_FILE" ]; then
  echo "❌ Could not locate the OpenClaw auth file containing checkBrowserOrigin." >&2
  echo "   OpenClaw source layout may have changed. Skipping patch." >&2
  exit 1
fi

if $SUDO grep -q "rawOriginNormalized" "$AUTH_FILE"; then
  echo "✓ Already patched: $AUTH_FILE"
  exit 0
fi

# Inject the raw-origin fallback right after the parsed-origin allowlist check.
# The target block is pretty-printed in current builds:
#
#   if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) return {
#       ok: true,
#       matchedBy: "allowlist"
#   };
#
# We append the fallback below it.
$SUDO python3 - "$AUTH_FILE" <<'PY'
import io, sys

path = sys.argv[1]
with io.open(path, "r", encoding="utf-8") as f:
    src = f.read()

target = (
    '\tif (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) return {\n'
    '\t\tok: true,\n'
    '\t\tmatchedBy: "allowlist"\n'
    '\t};\n'
)

if target not in src:
    sys.stderr.write(
        "ERROR: allowlist check block not found verbatim in " + path + "\n"
        "       OpenClaw source layout may have shifted; aborting without changes.\n"
    )
    sys.exit(2)

injection = (
    '\tconst rawOriginNormalized = normalizeOptionalLowercaseString(params.origin);\n'
    '\tif (rawOriginNormalized && allowlist.has(rawOriginNormalized)) return {\n'
    '\t\tok: true,\n'
    '\t\tmatchedBy: "allowlist"\n'
    '\t};\n'
)

# Back up
with io.open(path + ".obsidianclaw.bak", "w", encoding="utf-8") as f:
    f.write(src)

with io.open(path, "w", encoding="utf-8") as f:
    f.write(src.replace(target, target + injection, 1))

print("✓ Patched: " + path)
PY

echo "Restarting OpenClaw gateway…"
if command -v openclaw >/dev/null 2>&1; then
  openclaw gateway restart || true
else
  echo "   (openclaw CLI not on PATH — restart the gateway manually)"
fi

echo ""
echo "Done. ObsidianClaw should now connect."
echo "If you run 'openclaw update' later, re-run this script — the patch will be wiped."
