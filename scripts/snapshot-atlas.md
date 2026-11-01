# Snapshot & Restore Runbook (Atlas)

Phase 0 of `../../INVENTORY_AUDIT_ROADMAP.md` requires a documented backup/restore procedure
before any index change or data migration (Phase 2/9). This is that procedure. It has been
executed and verified once end-to-end — see "Verified baseline" below.

**Scope:** the whole Atlas cluster (every database), not just `test`.

## Facts (verified 2026-10-08)

| Fact | Value |
| --- | --- |
| Cluster | Atlas replica set `atlas-bb0bfr-shard-0`, hosts `ac-wd9znsx-shard-00-0{0,1,2}.on0pbcb.mongodb.net:27017` |
| Credentials | `MONGODB_URI` in `../.env` (never paste into a doc, a command log, or a ticket) |
| Live database | **`test`** — the URI carries no path, and `app.module.ts` sets no `dbName`, so the driver default applies. The app writes everything here. |
| Second database | `imraaah-dev` exists but its `test` collection is empty (legacy). |
| Data size | ~0.2 MB gzipped (dev cluster: 99 products, 388 variants, 388 balances, 687 movements, 5 orders, 12 stores, 13 users) |
| Tooling | MongoDB Database Tools (`mongodump` / `mongorestore`) |

## Getting the tools

**Option A (portable, no admin rights — what was used):**

```powershell
$dest = "$env:LOCALAPPDATA\mongo-tools"
Invoke-WebRequest -Uri "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.19.1.zip" -OutFile "$env:TEMP\mongo-tools.zip"
Expand-Archive "$env:TEMP\mongo-tools.zip" $dest -Force
$env:Path += ";$dest\mongodb-database-tools-windows-x86_64-100.19.1\bin"
```

**Option B (installer):** `winget install MongoDB.DatabaseTools` — needs an elevated prompt;
the silent MSI fails with exit code 1602 if UAC is declined.

The portable copy used for the baseline lived in the session temp dir
(`…\Temp\opencode\mongo-tools\…`), which is wiped with temp cleanup — **re-extract with
Option A if `mongodump` is missing.**

## Taking a snapshot

Run from `IMRAAAH-BACK/`. The URI is read from `.env` and never printed:

```powershell
$uri = ((Get-Content .env | Where-Object { $_ -match '^MONGODB_URI=' }) -replace '^MONGODB_URI=','').Trim()
$ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path .\backups -Force | Out-Null
& mongodump --uri="$uri" --archive=".\backups\snapshot-$ts.archive.gz" --gzip
& mongorestore --uri="$uri" --archive=".\backups\snapshot-$ts.archive.gz" --gzip --dryRun   # must exit 0
```

`--dryRun` parses the archive and resolves every collection without writing. **A snapshot that
has not passed `--dryRun` is not a snapshot.**

`backups/` is gitignored — archives must never be committed (they contain real users/orders).

## When to snapshot

- **Mandatory before:** any Phase 2/9 index addition or data migration; any hand-run script
  that writes to the live DB (`scripts/migrate-*.js`, `scripts/purge-*.js`, `scripts/fix-*.js`).
- **Recommended after:** any run of such a script, so you can diff forward *and* roll back.
- Keep the most recent pre-change archive until the change has survived a full verification pass.

## Restore runbook

### Full restore (rollback a bad migration across the board)

```powershell
$uri = ((Get-Content .env | Where-Object { $_ -match '^MONGODB_URI=' }) -replace '^MONGODB_URI=','').Trim()
& mongorestore --uri="$uri" --archive=".\backups\<snapshot>.archive.gz" --gzip --drop
```

`--drop` is required for a true rollback: it deletes each target collection before recreating
it from the archive. Without it, restored documents merge into (and duplicate against) what is
already there.

**Stop the backend first** (`Ctrl+C` on `npm run start:dev`). Mongoose connections hold open
cursors during a drop and can re-write in-flight state after the restore.

### Single-collection restore (targeted rollback)

Use when only one collection was damaged (e.g. a bad balance backfill):

```powershell
& mongorestore --uri="$uri" --archive=".\backups\<snapshot>.archive.gz" --gzip `
  --nsInclude 'test.inventorybalances' --drop
```

Common pairs for inventory work:

| Damaged by | Restore |
| --- | --- |
| Bad stock/balance migration | `test.inventorybalances` + `test.inventorymovements` (restore **both**, they are one logical unit) |
| Bad variant/option migration | `test.productvariants` + `test.productoptions` + `test.productoptionvalues` + `test.variantoptionvalues` |
| Bad product edit/sweep | `test.products` |
| Bad order mutation | `test.orders` |

Restoring balances without movements (or vice versa) recreates the exact drift the
reconciliation script exists to catch — always restore them as a pair.

### After any restore

1. `node scripts/verify-inventory-reconciliation.js` — must print `CLEAN`.
2. `node scripts/verify-inventory-integrity.js` — must be violation-free.
3. `npm test` — suite must be unchanged from the recorded baseline.
4. Re-run whatever migration was rolled back only after fixing its defect; snapshot again first.

## Alternative: Atlas UI snapshots

Atlas → your cluster → **Backup/ Snapshots → Take Snapshot**, then restore from the same page.
This is the safest option where available, **but**: shared-tier clusters (M0/M2) do not support
snapshot restore at all, and tier/features vary — verify your tier before relying on it.
`mongodump` above works on every tier and is therefore the canonical procedure here.

## Verified baseline (2026-10-08, Phase 0)

- Snapshot: `backups/pre-phase2-20261008-120249.archive.gz` (0.21 MB, 30 collections across
  `test` + `imraaah-dev`), `mongorestore --dryRun` → exit 0.
- `npm test`: 281 tests — **280 pass**, 1 pre-existing failure (`app.controller.spec.ts`).
- `npx tsc --noEmit`: clean except the same pre-existing `app.controller.spec.ts:19` error.
- vendorFront: `npx tsc --noEmit` clean, `npx next build` exit 0 (ESLint circular-config error
  is pre-existing and non-blocking).
- storefront: `npm run test:pixels` → 53/53 pass.
