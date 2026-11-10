-- AI receptionist schema, from the final plan (2026-11-10).
-- Every business-owned row carries business_id; nothing cascades on delete,
-- because an archived business still owes its call history.
-- Two tables beyond the plan's list are what the code needs today:
-- opt_outs (STOP suppression list) and the idempotency_key on bookings.

create table flows (
  id              text primary key,        -- 'discovery_call' | 'rolloff_quote'
  slots           jsonb not null,          -- ordered [{key, required, ask, validate}]
  tools           text[] not null,
  summary_tpl     text not null,
  handoff         text not null            -- 'calendar' | 'dispatcher'
);

create table businesses (
  id              text primary key,
  name            text not null,
  inbound_did     text unique not null,
  transfer_did    text not null,
  transfer_hours  jsonb not null,          -- {days:[1-5], start, end}
  tz              text not null,
  voice_id        text not null,
  greeting        text not null,
  flow_id         text not null references flows(id),
  call_cap_day    int not null default 60,
  spend_cap_day   numeric not null default 25,
  archived_at     timestamptz,             -- archive, never hard-delete
  created_at      timestamptz default now()
);

create table catalog (
  business_id     text references businesses(id),
  kind            text not null,           -- 'size' | 'fee' | 'area'
  key             text not null,
  value           jsonb not null,
  primary key (business_id, kind, key)
);

create table faq_entries (
  id              serial primary key,
  business_id     text not null references businesses(id),
  question        text not null,
  answer          text not null,           -- approved wording, verbatim
  updated_at      timestamptz default now()
);

create table calls (
  id              text primary key,        -- Vapi call id
  business_id     text not null references businesses(id),
  from_number     text,
  caller_name     text,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  outcome         text,                    -- booked|transferred|message|spam|abandoned|wrong_number|text_back
  ended_reason    text,
  transcript      jsonb,
  summary         text,
  recording_key   text,                    -- R2 object key
  keep_for_demo   boolean default false,   -- blocks the 90-day sweep
  demo_consent_at timestamptz,             -- caller's separate yes to public use
  latency_ms      int[],
  tool_errors     int default 0,
  catalog_snapshot jsonb                   -- FAQ and catalog frozen at call start
);
create index calls_business_started on calls (business_id, started_at);

create table bookings (
  id              serial primary key,
  idempotency_key text unique not null,    -- one booking per attempt, ever
  call_id         text references calls(id),
  business_id     text not null references businesses(id),
  state           text not null,           -- pending|booked|uncertain|failed
  fields          jsonb not null,
  summary_read    text not null,
  target          text not null,           -- 'cal.com' | 'ghl'
  external_id     text,
  acknowledged_at timestamptz,
  created_at      timestamptz default now()
);

create table text_threads (
  id              serial primary key,
  business_id     text not null references businesses(id),
  number          text not null,
  direction       text not null,           -- in | out
  body            text not null,
  consent_basis   text,                    -- e.g. 'reply_to_inbound_call:<call id>'
  created_at      timestamptz default now()
);
create index text_threads_business_number on text_threads (business_id, number, created_at);

create table opt_outs (
  number          text primary key,
  opted_out_at    timestamptz not null default now()
);

create table switches (
  id              text primary key,        -- 'owner_pause:<business>' | 'global_kill'
  business_id     text,                    -- null for global
  set             boolean not null default false,
  set_at          timestamptz,
  set_by          text
);
-- The watchdog's state lives in the running service, not here, so an owner
-- command can never clear it.

create table price_checks (
  call_id         text primary key references calls(id),
  figures         jsonb not null,          -- extracted from the transcript
  mismatches      jsonb not null,
  passed          boolean not null,
  checked_at      timestamptz default now()
);
