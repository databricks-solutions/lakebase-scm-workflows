#!/usr/bin/env bash
# Run database migrations using the branch URL from .env (post-checkout hook writes it).
# Detects project language and calls the appropriate migration tool.
# Usage: ./scripts/flyway-migrate.sh [extra args]
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
if [ ! -f .env ]; then
  echo "No .env found. Run 'git checkout <branch>' so the hook creates/updates .env, or copy .env.example to .env."
  exit 1
fi
set -a
# shellcheck source=/dev/null
source .env 2>/dev/null || true
set +a

# Build DATABASE_URL from SPRING_DATASOURCE_* if not already set (backward compat).
# URL-encode both username and password — the email-style username always
# contains '@' which otherwise confuses libpq/psycopg DSN parsing.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${SPRING_DATASOURCE_URL:-}" ]; then
  DATABASE_URL="$(echo "$SPRING_DATASOURCE_URL" | sed 's|^jdbc:postgresql://|postgresql://|')"
  if [ -n "${SPRING_DATASOURCE_USERNAME:-}" ] && [ -n "${SPRING_DATASOURCE_PASSWORD:-}" ]; then
    ENCODED_USER="$(printf '%s' "$SPRING_DATASOURCE_USERNAME" | sed 's/@/%40/g; s/:/%3A/g; s/\//%2F/g; s/?/%3F/g; s/#/%23/g')"
    ENCODED_PASS="$(printf '%s' "$SPRING_DATASOURCE_PASSWORD" | sed 's/@/%40/g; s/:/%3A/g; s/\//%2F/g; s/?/%3F/g; s/#/%23/g')"
    DATABASE_URL="$(echo "$DATABASE_URL" | sed "s|postgresql://|postgresql://${ENCODED_USER}:${ENCODED_PASS}@|")"
  fi
  export DATABASE_URL
fi

# Detect project language
if [ -f "$REPO_ROOT/pom.xml" ]; then
  # Java / Maven / Flyway — export SPRING_DATASOURCE_* for Maven/Spring
  if [ -z "${SPRING_DATASOURCE_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
    SPRING_DATASOURCE_URL="jdbc:$(echo "$DATABASE_URL" | sed 's|^postgresql://[^@]*@|postgresql://|')"
    SPRING_DATASOURCE_USERNAME="${DB_USERNAME:-}"
    SPRING_DATASOURCE_PASSWORD="${DB_PASSWORD:-}"
  fi
  if [ -z "${SPRING_DATASOURCE_URL:-}" ]; then
    echo "DATABASE_URL (or SPRING_DATASOURCE_URL) not set in .env."
    exit 1
  fi
  export SPRING_DATASOURCE_URL SPRING_DATASOURCE_USERNAME SPRING_DATASOURCE_PASSWORD
  ./mvnw flyway:migrate "$@"
elif [ -f "$REPO_ROOT/requirements.txt" ] || [ -f "$REPO_ROOT/pyproject.toml" ]; then
  # Python / Alembic
  if [ -d ".venv" ]; then
    source .venv/bin/activate
  fi
  alembic upgrade head "$@"
elif [ -f "$REPO_ROOT/package.json" ]; then
  # Node.js / Knex
  npx knex migrate:latest "$@"
else
  echo "Could not detect project language. Expected pom.xml (Java), pyproject.toml/requirements.txt (Python), or package.json (Node.js)."
  exit 1
fi
