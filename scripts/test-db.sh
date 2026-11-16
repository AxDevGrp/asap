#!/usr/bin/env bash
set -euo pipefail

# Runs the SQL test suite against the local Supabase Postgres.
# This script never targets a remote database: it refuses any arguments and
# any non-local TEST_DB_URL, then resets the local stack via `supabase db reset`.
if [[ $# -gt 0 ]]; then
  echo "test-db: refusing arguments ($*) — this script only runs against the local DB" >&2
  exit 2
fi

TEST_DB_URL="${TEST_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

case "$TEST_DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@\[::1\]:*) ;;
  *)
    echo "test-db: refusing non-local TEST_DB_URL (host must be 127.0.0.1/localhost)" >&2
    exit 2
    ;;
esac

echo "==> supabase db reset (local)"
supabase db reset

shopt -s nullglob
files=(scripts/sql-tests/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "test-db: no scripts/sql-tests/*.sql files found" >&2
  exit 1
fi

failed=0
for file in "${files[@]}"; do
  if psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -q -f "$file"; then
    echo "PASS $file"
  else
    echo "FAIL $file" >&2
    failed=1
  fi
done

exit "$failed"
