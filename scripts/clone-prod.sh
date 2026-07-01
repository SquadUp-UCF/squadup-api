#!/usr/bin/env bash
#
# Clone the production database into the local container as an ANONYMIZED copy:
# real structure, volume, and relationships — but no real user PII.
#
# Steps: dump prod (read-only) -> restore into the local container (dropping the
# existing local data) -> anonymize the local copy -> delete the raw dump.
#
# Prerequisites:
#   - MongoDB Database Tools (mongodump/mongorestore): `brew install mongodb-database-tools`
#   - The local Mongo container running: `docker compose up -d`
#
# Usage:
#   PROD_MONGO_URI="mongodb+srv://USER:PASS@cluster.mongodb.net/squadup" \
#     npm run db:clone-prod
#
# Optional overrides:
#   LOCAL_HOST_URI (default mongodb://localhost:27017)
#   PROD_DB        (default squadup)      LOCAL_DB (default squadup_dev)
set -euo pipefail

: "${PROD_MONGO_URI:?Set PROD_MONGO_URI to the Atlas connection string (read-only use)}"
LOCAL_HOST_URI="${LOCAL_HOST_URI:-mongodb://localhost:27017}"
PROD_DB="${PROD_DB:-squadup}"
LOCAL_DB="${LOCAL_DB:-squadup_dev}"

DUMP_DIR="$(mktemp -d)"
# Always remove the raw (real-PII) dump, even on failure.
trap 'rm -rf "$DUMP_DIR"' EXIT

echo "==> Dumping prod (read-only)…"
mongodump --uri="$PROD_MONGO_URI" --out="$DUMP_DIR"

echo "==> Restoring into local ${LOCAL_DB} (drops existing local data)…"
# Point at the dump ROOT (not the db subdir) so the namespace remap applies.
mongorestore --uri="$LOCAL_HOST_URI" --drop \
  --nsFrom="${PROD_DB}.*" --nsTo="${LOCAL_DB}.*" \
  "$DUMP_DIR"

echo "==> Anonymizing the local copy…"
LOCAL_DB_URI="${LOCAL_HOST_URI}/${LOCAL_DB}" npx ts-node scripts/anonymize-db.ts

echo "==> Done. Raw dump discarded; local ${LOCAL_DB} holds an anonymized clone."
