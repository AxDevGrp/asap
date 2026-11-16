-- 000_smoke.sql — every table in schema public must have RLS enabled.
do $$
declare
  missing text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename)
    into missing
  from pg_tables
  where schemaname = 'public'
    and not rowsecurity;

  if missing is not null then
    raise exception 'RLS not enabled on public tables: %', missing;
  end if;
end
$$;
