# Legacy migrations (historical, superseded)

These files are the original ASAP schema, written to be pasted **one at a time**
into the Supabase SQL editor — never replayed from scratch. They are kept here
unmodified for reference only.

They have been **superseded** by the squashed baseline:

    supabase/migrations/20261109000000_baseline.sql

Use the baseline for any fresh project.

## Known replay problems (verified on a fresh local Supabase)

Applying 001..012 in filename order on a clean database fails in two places:

- **Two files share the `003` prefix** (`003_auto_resolve_audit.sql` and
  `003_kb_seed_reference.sql`). The Supabase CLI migration runner rejects the
  duplicate version. `003_kb_seed_reference.sql` is reference-only (all SQL is
  commented out) and was skipped for this reason.
- **008_conversations_and_engine.sql line 106** creates
  `outbound_messages_conversation_idx` on `outbound_messages(conversation_id)`,
  but that column is never added: 007 already created `outbound_messages`
  without it, so 008's `CREATE TABLE IF NOT EXISTS` is skipped and never adds
  `conversation_id`. Fix was to `ALTER TABLE outbound_messages ADD COLUMN
  conversation_id ...` before the index.
- **012_drop_chatwoot_columns.sql line 13** does `DROP INDEX
  tickets_chatwoot_convo_id_key`, but that index backs a UNIQUE *constraint*
  and cannot be dropped directly. Fix was `ALTER TABLE tickets DROP CONSTRAINT
  IF EXISTS tickets_chatwoot_convo_id_key` first.

Other silent-skip hazards (did not error, but are why the baseline is a
straight CREATE of final shape):

- 004 and 008 both `CREATE TABLE IF NOT EXISTS tenants`; 008's version adds
  `chatwoot_inbox_id`/`chatwoot_account_id` which 004's lacks, so the second
  CREATE is skipped. Those columns only exist because 005 added them.
- 008 tries to `ADD COLUMN direction ... check in ('inbound','outbound')` but
  `messages.direction` already exists from 001 with `('incoming','outgoing')`,
  so the new check is silently ignored (the original one stays).
- 006 does not *replace* the 002 function — it adds a second 5-arg overload,
  leaving two `match_knowledge_base` signatures in the final schema.

See the final report for the full list of intentional differences between the
legacy result and the baseline.
