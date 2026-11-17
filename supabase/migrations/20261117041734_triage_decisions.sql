-- Triage decisions (ASAP-9)
--
-- Adds the per-tenant decision mode + thresholds that drive the triage
-- decision shadow/LLM/JEV modes, and the ai_suggested_* columns where the
-- pipeline records decision suggestions. Suggestions are never applied
-- automatically.
--
-- Idempotent: safe to re-run. Adding a column does not fire the tickets
-- updated_at trigger (triggers fire on UPDATE only).

-- ═══════════════════════════════════════════════════════════════════════════════
-- tenant_policies: decision mode + thresholds
-- ═══════════════════════════════════════════════════════════════════════════════
alter table tenant_policies
  add column if not exists decision_mode text not null default 'shadow'
    check (decision_mode in ('llm', 'shadow', 'jev')),
  add column if not exists decision_thresholds jsonb not null
    default '{"spam_auto_decline":0.95,"label_suggest":0.7,"needs_human":0.5}'::jsonb;

-- ═══════════════════════════════════════════════════════════════════════════════
-- tickets: AI suggestions (stored only, never applied)
-- ═══════════════════════════════════════════════════════════════════════════════
alter table tickets
  add column if not exists ai_suggested_priority text
    check (ai_suggested_priority in ('low', 'medium', 'high', 'urgent')),
  add column if not exists ai_suggested_label_ids uuid[],
  add column if not exists ai_spam_probability numeric(4,3)
    check (ai_spam_probability between 0 and 1),
  add column if not exists ai_needs_human_probability numeric(4,3)
    check (ai_needs_human_probability between 0 and 1),
  add column if not exists ai_suggested_type text;
