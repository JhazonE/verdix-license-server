#!/usr/bin/env bash
# Run the license server against the LOCAL STAGING database.
# ---------------------------------------------------------------------------
# The repo's .env points LICENSE_DB_* at metro.proxy.rlwy.net — the LIVE
# production licence database holding real customers. Testing against it would
# create real licence rows and mutate the real activations table.
#
# This script overrides those variables in the environment (which takes
# precedence over .env) so everything lands in a throwaway local database
# instead. It never edits .env, so there is no modified state to forget about.
#
#   ./staging.sh server        # dashboard on http://localhost:4100
#   ./staging.sh migrate       # (re)create the staging schema
#   ./staging.sh seed-admin    # recreate the admin login
#   ./staging.sh psql          # open a mysql shell on the staging DB
#   ./staging.sh reset         # DROP and recreate the staging DB from scratch
#
# Dashboard login: admin / staging-only-pw
set -euo pipefail

# Reuse the local MySQL root password from the POS repo's .env.
POS_ENV="d:/VERDIX_POS/Verdix_POS/.env"
DB_PW="$(grep -E '^DB_PASSWORD=' "$POS_ENV" | cut -d= -f2- | tr -d '\r')"

export LICENSE_DB_HOST=127.0.0.1
export LICENSE_DB_PORT=3306
export LICENSE_DB_USER=root
export LICENSE_DB_PASSWORD="$DB_PW"
export LICENSE_DB_NAME=verdix_license_staging
export LICENSE_DB_SSL=
export LICENSE_UI_PORT=4100

# Guard: refuse to run if anything still points at the production host.
if [[ "$LICENSE_DB_HOST" == *"rlwy.net"* || "$LICENSE_DB_NAME" != *"staging"* ]]; then
  echo "REFUSING: this does not look like the staging database." >&2
  exit 1
fi

echo "→ licence DB: $LICENSE_DB_USER@$LICENSE_DB_HOST:$LICENSE_DB_PORT/$LICENSE_DB_NAME"

case "${1:-server}" in
  server)     npx tsx src/server.ts ;;
  migrate)    npx tsx src/schema.ts ;;
  seed-admin) npx tsx src/seed-admin.ts --username admin --password "staging-only-pw" ;;
  psql)       MYSQL_PWD="$DB_PW" mysql -h 127.0.0.1 -P 3306 -u root "$LICENSE_DB_NAME" ;;
  reset)
    MYSQL_PWD="$DB_PW" mysql -h 127.0.0.1 -P 3306 -u root \
      -e "DROP DATABASE IF EXISTS $LICENSE_DB_NAME; CREATE DATABASE $LICENSE_DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
    npx tsx src/schema.ts
    npx tsx src/seed-admin.ts --username admin --password "staging-only-pw"
    echo "✅ staging database reset."
    ;;
  *) echo "usage: ./staging.sh [server|migrate|seed-admin|psql|reset]" >&2; exit 1 ;;
esac
