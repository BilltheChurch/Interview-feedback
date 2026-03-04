#!/usr/bin/env bash
# deploy-d1.sh — Create D1 databases and run initial migration
# Usage: ./scripts/deploy-d1.sh
# Prerequisite: wrangler CLI installed and authenticated (npx wrangler whoami)

set -euo pipefail

MIGRATION_FILE="migrations/0001_init.sql"
PROD_DB="chorus-meta"
STAGING_DB="chorus-meta-staging"
WRANGLER_JSONC="wrangler.jsonc"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "[deploy-d1] $*"; }
warn() { echo "[deploy-d1] WARNING: $*" >&2; }
die()  { echo "[deploy-d1] ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not found. Run: npm install -g wrangler"
}

extract_database_id() {
  # Parse database_id from `wrangler d1 create` output
  # Output contains a line like: database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  grep -o 'database_id = "[^"]*"' | head -1 | sed 's/database_id = "//;s/"//'
}

# ── Preflight ─────────────────────────────────────────────────────────────────

require_cmd npx

cd "$(dirname "$0")/.." || die "Could not cd to edge/worker directory"

[[ -f "$MIGRATION_FILE" ]] || die "Migration file not found: $MIGRATION_FILE"
[[ -f "$WRANGLER_JSONC" ]] || die "wrangler.jsonc not found in $(pwd)"

log "Checking wrangler authentication..."
npx wrangler whoami >/dev/null 2>&1 || die "Not authenticated. Run: npx wrangler login"

# ── Create Production Database ────────────────────────────────────────────────

log "Creating production D1 database: $PROD_DB"
PROD_CREATE_OUTPUT=$(npx wrangler d1 create "$PROD_DB" 2>&1) || {
  # Database may already exist — try to list and continue
  warn "Creation returned non-zero exit (database may already exist). Continuing..."
  PROD_CREATE_OUTPUT=$(npx wrangler d1 list 2>&1)
}
echo "$PROD_CREATE_OUTPUT"

PROD_ID=$(echo "$PROD_CREATE_OUTPUT" | extract_database_id)

if [[ -z "$PROD_ID" ]]; then
  # Fallback: extract from d1 list output
  PROD_ID=$(npx wrangler d1 list 2>&1 | grep "$PROD_DB" | grep -o '[0-9a-f-]\{36\}' | head -1)
fi

[[ -n "$PROD_ID" ]] || die "Could not determine database_id for $PROD_DB. Check output above."
log "Production database_id: $PROD_ID"

# ── Create Staging Database ───────────────────────────────────────────────────

log "Creating staging D1 database: $STAGING_DB"
STAGING_CREATE_OUTPUT=$(npx wrangler d1 create "$STAGING_DB" 2>&1) || {
  warn "Creation returned non-zero exit (database may already exist). Continuing..."
  STAGING_CREATE_OUTPUT=$(npx wrangler d1 list 2>&1)
}
echo "$STAGING_CREATE_OUTPUT"

STAGING_ID=$(echo "$STAGING_CREATE_OUTPUT" | extract_database_id)

if [[ -z "$STAGING_ID" ]]; then
  STAGING_ID=$(npx wrangler d1 list 2>&1 | grep "$STAGING_DB" | grep -o '[0-9a-f-]\{36\}' | head -1)
fi

[[ -n "$STAGING_ID" ]] || die "Could not determine database_id for $STAGING_DB. Check output above."
log "Staging database_id: $STAGING_ID"

# ── Run Migrations ────────────────────────────────────────────────────────────

log "Running migration on production ($PROD_DB)..."
npx wrangler d1 execute "$PROD_DB" --file="$MIGRATION_FILE" --remote
log "Production migration complete."

log "Running migration on staging ($STAGING_DB)..."
npx wrangler d1 execute "$STAGING_DB" --file="$MIGRATION_FILE" --remote
log "Staging migration complete."

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo "  D1 Setup Complete"
echo "══════════════════════════════════════════════════════════════════════"
echo ""
echo "  Next step: update wrangler.jsonc with the database IDs below."
echo ""
echo "  Production (top-level d1_databases):"
echo "    \"database_id\": \"$PROD_ID\""
echo ""
echo "  Staging (env.staging.d1_databases):"
echo "    \"database_id\": \"$STAGING_ID\""
echo ""
echo "  In wrangler.jsonc, replace both REPLACE_AFTER_CREATE placeholders."
echo ""
echo "  Verify schemas:"
echo "    npx wrangler d1 execute $PROD_DB --remote --command \"SELECT name FROM sqlite_master WHERE type='table'\""
echo "    npx wrangler d1 execute $STAGING_DB --remote --command \"SELECT name FROM sqlite_master WHERE type='table'\""
echo ""
echo "══════════════════════════════════════════════════════════════════════"
