#!/usr/bin/env bash
# Set up Lakehouse Federation for a Lakebase project.
#
# Creates a native Postgres role with SCRAM-SHA-256 auth for Federation,
# since Federation's Postgres connector only supports static user/password
# (not OAuth JWTs). This is a one-time setup per project.
#
# What this does:
#   1. Creates a native Postgres role (feduser) with a generated password
#   2. Grants read-only access to the public schema
#   3. Creates a Databricks connection using the native role
#   4. Creates a foreign catalog for SQL queries from the lakehouse side
#
# Prerequisites:
#   - psql installed
#   - .env with LAKEBASE_HOST, DB_USERNAME, DB_PASSWORD
#   - databricks CLI authenticated
#
# Usage:
#   ./scripts/setup-federation.sh [database_name] [catalog_name]
#
# Example:
#   ./scripts/setup-federation.sh backstage_plugin_catalog lakebase_backstage
#
# Based on Cameron Casher's Lakebase-Backstage POC (ThoughtWorks, April 2026).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env" 2>/dev/null || true
  set +a
fi

DB_NAME="${1:-databricks_postgres}"
CATALOG_NAME="${2:-lakebase_fed}"
FED_USER="feduser"
FED_PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)"
HOST="${LAKEBASE_HOST:?LAKEBASE_HOST not set in .env}"

echo "=== Lakehouse Federation Setup ==="
echo "Host:     $HOST"
echo "Database: $DB_NAME"
echo "Fed user: $FED_USER"
echo "Catalog:  $CATALOG_NAME"
echo ""

# Step 1: Create native Postgres role
echo "Step 1: Creating native Postgres role '$FED_USER'..."
PGPASSWORD="$DB_PASSWORD" psql \
  "host=$HOST port=5432 dbname=$DB_NAME user=$DB_USERNAME sslmode=require" \
  -c "
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$FED_USER') THEN
        CREATE ROLE $FED_USER WITH LOGIN PASSWORD '$FED_PASS'
          NOSUPERUSER NOCREATEDB NOCREATEROLE;
        RAISE NOTICE 'Role $FED_USER created.';
      ELSE
        ALTER ROLE $FED_USER WITH PASSWORD '$FED_PASS';
        RAISE NOTICE 'Role $FED_USER already exists. Password updated.';
      END IF;
    END
    \$\$;
  "

# Step 2: Grant read-only access
echo "Step 2: Granting read-only access to public schema..."
PGPASSWORD="$DB_PASSWORD" psql \
  "host=$HOST port=5432 dbname=$DB_NAME user=$DB_USERNAME sslmode=require" \
  -c "
    GRANT USAGE ON SCHEMA public TO $FED_USER;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO $FED_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $FED_USER;
  "

# Step 3: Create Databricks connection
echo "Step 3: Creating Databricks connection '${CATALOG_NAME}_conn'..."
CONNECTION_NAME="${CATALOG_NAME}_conn"
databricks connections create --json "{
  \"name\": \"$CONNECTION_NAME\",
  \"connection_type\": \"POSTGRESQL\",
  \"options\": {
    \"host\": \"$HOST\",
    \"port\": \"5432\",
    \"user\": \"$FED_USER\",
    \"password\": \"$FED_PASS\"
  }
}" 2>&1 || echo "Connection may already exist. Continuing..."

# Step 4: Create foreign catalog
echo "Step 4: Creating foreign catalog '$CATALOG_NAME'..."
databricks catalogs create --json "{
  \"name\": \"$CATALOG_NAME\",
  \"connection_name\": \"$CONNECTION_NAME\",
  \"options\": {
    \"database\": \"$DB_NAME\"
  }
}" 2>&1 || echo "Catalog may already exist. Continuing..."

echo ""
echo "=== Federation Setup Complete ==="
echo ""
echo "You can now query Lakebase tables from the lakehouse:"
echo "  SELECT * FROM $CATALOG_NAME.public.<table_name> LIMIT 10;"
echo ""
echo "To join with system tables (e.g., billing):"
echo "  SELECT f.*, u.usage_quantity"
echo "  FROM $CATALOG_NAME.public.<table> f"
echo "  JOIN system.billing.usage u ON ..."
echo ""
echo "IMPORTANT: The federation password is stored in the Databricks connection."
echo "Rotation is manual -- rerun this script to generate a new password."
echo ""
echo "Federation credentials (save securely):"
echo "  User:     $FED_USER"
echo "  Password: $FED_PASS"
