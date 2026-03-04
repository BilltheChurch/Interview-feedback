# D1 Database Migrations

Chorus uses Cloudflare D1 (SQLite) for lightweight session metadata. Full result JSON and audio blobs are stored in R2.

## Prerequisites

- Wrangler CLI: `npm install -g wrangler` (or use `npx wrangler`)
- Authenticated: `npx wrangler login`
- Cloudflare account with D1 enabled

## Quick Start — Create Databases and Run Migration

```bash
cd edge/worker
chmod +x scripts/deploy-d1.sh
./scripts/deploy-d1.sh
```

The script will:
1. Create `chorus-meta` (production) and `chorus-meta-staging` (staging) D1 databases
2. Run `migrations/0001_init.sql` on both
3. Print the `database_id` values to paste into `wrangler.jsonc`

## Manual Steps

### 1. Create Databases

```bash
# Production
npx wrangler d1 create chorus-meta

# Staging
npx wrangler d1 create chorus-meta-staging
```

Copy the `database_id` from each output and update `wrangler.jsonc`:

```jsonc
// Top-level (production)
"d1_databases": [{ "binding": "DB", "database_name": "chorus-meta", "database_id": "<PROD_ID>" }]

// env.staging
"d1_databases": [{ "binding": "DB", "database_name": "chorus-meta-staging", "database_id": "<STAGING_ID>" }]
```

### 2. Run Migrations

```bash
# Production
npx wrangler d1 execute chorus-meta --file=migrations/0001_init.sql --remote

# Staging
npx wrangler d1 execute chorus-meta-staging --file=migrations/0001_init.sql --remote
```

Migrations use `CREATE TABLE IF NOT EXISTS` and are safe to re-run.

## Verify Schema

```bash
# List all tables
npx wrangler d1 execute chorus-meta --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# Describe a table
npx wrangler d1 execute chorus-meta --remote \
  --command "PRAGMA table_info(sessions)"
```

Expected tables: `organizations`, `users`, `sessions`, `dimension_scores`, `rubric_templates`, `gdpr_audit_log`

## Query Data

```bash
# Count sessions by phase
npx wrangler d1 execute chorus-meta --remote \
  --command "SELECT phase, COUNT(*) FROM sessions GROUP BY phase"

# Recent sessions
npx wrangler d1 execute chorus-meta --remote \
  --command "SELECT id, title, phase, created_at FROM sessions ORDER BY created_at DESC LIMIT 10"

# Dimension scores for a session
npx wrangler d1 execute chorus-meta --remote \
  --command "SELECT person_name, dimension, score FROM dimension_scores WHERE session_id='<SESSION_ID>'"
```

## Production vs Staging

| Aspect | Production | Staging |
|---|---|---|
| Database | `chorus-meta` | `chorus-meta-staging` |
| R2 bucket | `interview-feedback-results` | `interview-feedback-results-staging` |
| Deploy command | `npx wrangler deploy` | `npx wrangler deploy --env staging` |
| Tier 2 | enabled | disabled |
| Audio retention | 72h | 24h |

Use staging for testing migrations before applying to production.

## Adding New Migrations

1. Create `migrations/000N_description.sql` (increment the number)
2. Use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` for safety
3. Test on staging first: `npx wrangler d1 execute chorus-meta-staging --file=migrations/000N_description.sql --remote`
4. Apply to production: `npx wrangler d1 execute chorus-meta --file=migrations/000N_description.sql --remote`

## Rollback Strategy

D1 does not support automatic rollback of applied migrations. To roll back:

1. Write a compensating migration (e.g., `000N_rollback_description.sql`) that reverses the change:
   - Drop newly added columns: `ALTER TABLE t DROP COLUMN col` (SQLite 3.35+)
   - Restore dropped data from R2 backups if needed
   - Recreate dropped tables from the original schema

2. Apply the compensating migration on staging, verify, then apply to production.

3. For destructive changes (DROP TABLE), export data first:
   ```bash
   npx wrangler d1 export chorus-meta --remote --output=backup_$(date +%Y%m%d).sql
   ```

> D1 export is available via `wrangler d1 export` (wrangler ≥ 3.40). Keep backups before any destructive migration.
