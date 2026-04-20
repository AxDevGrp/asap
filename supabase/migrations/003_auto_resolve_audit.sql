-- ASAP Phase 3 — Auto-Resolve Audit Trail
-- Run in Supabase Dashboard → SQL Editor → Run

-- ── Add auto-resolve columns to tickets ───────────────────────────────────────
alter table tickets
  add column if not exists auto_resolved   boolean default false,
  add column if not exists resolve_reason  text;

-- ── Index for filtering auto-resolved tickets ─────────────────────────────────
create index if not exists tickets_auto_resolved_idx on tickets(auto_resolved) where auto_resolved = true;

-- ── Auto-resolve audit log ───────────────────────────────────────────────────
-- Records every auto-resolve decision (both sent and draft) for analysis.
create table if not exists resolve_audit (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid references tickets(id) on delete cascade,
  chatwoot_convo_id integer not null,
  product         text not null,

  -- Decision
  auto_send       boolean not null,
  reason          text not null,

  -- Context at decision time
  triage_confidence  numeric(3,2),
  triage_type        text,
  triage_urgency     text,
  kb_hits            integer,
  top_kb_similarity  numeric(3,2),

  created_at      timestamptz default now()
);

create index if not exists resolve_audit_product_idx on resolve_audit(product);
create index if not exists resolve_audit_auto_send_idx on resolve_audit(auto_send);
create index if not exists resolve_audit_created_at_idx on resolve_audit(created_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table resolve_audit enable row level security;
create policy "service full access resolve_audit" on resolve_audit for all using (true);
