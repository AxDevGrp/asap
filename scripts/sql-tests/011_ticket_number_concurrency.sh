#!/usr/bin/env bash
# 011_ticket_number_concurrency.sh — parallel inserts must produce 1..10,
# unique and gap-free, per tenant.
set -euo pipefail

TEST_DB_URL="${TEST_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

cleanup() {
  if [[ -n "${tenant_id:-}" ]]; then
    psql "$TEST_DB_URL" -q -c "delete from public.tickets where tenant_id = '$tenant_id';" || true
    psql "$TEST_DB_URL" -q -c "delete from public.tenants where id = '$tenant_id';" || true
  fi
}
trap cleanup EXIT

tenant_id="$(psql "$TEST_DB_URL" -Atq -v ON_ERROR_STOP=1 \
  -c "insert into public.tenants (name, slug, domain) values ('Concurrency 011', 'concurrency-011', 'concurrency011.test') returning id;")"

pids=()
for i in $(seq 1 10); do
  psql "$TEST_DB_URL" -q -v ON_ERROR_STOP=1 \
    -c "insert into public.tickets (tenant_id, subject) values ('$tenant_id', 'parallel $i');" &
  pids+=("$!")
done

for pid in "${pids[@]}"; do
  wait "$pid"
done

numbers="$(psql "$TEST_DB_URL" -At -v ON_ERROR_STOP=1 \
  -c "select string_agg(number::text, ',' order by number) from public.tickets where tenant_id = '$tenant_id';")"

if [[ "$numbers" != "1,2,3,4,5,6,7,8,9,10" ]]; then
  echo "FAIL: expected numbers 1..10, got '${numbers}'" >&2
  exit 1
fi

echo "PASS: parallel inserts produced 1..10"
