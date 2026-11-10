# STATE

## Status (2026-11-10): matches the final plan, not deployed
Plan: https://claude.ai/artifact/91wucVfWdBXVbStkszR8Ta (final 2026-11-10; next change only after QA row 25 passes).

- Built and tested with fakes (32 tests): Twilio voice switch with a fail-closed
  1.5 s pause check; owner PAUSE/RESUME/STATUS by text with confirmations;
  watchdog with 3-fail trip / 3-success restore and owner texts; week-1 stub
  agent (`AGENT_MODE=stub`); full assistant with disclosure first, FAQ, transfer
  rules, open times preloaded; idempotent booking; urgent vs routine alerts;
  missed-call text-back; STOP; caps; signature checks; per-dependency timeouts.
- State persists in a JSON file (`STATE_FILE`, on a Fly volume); `db/schema.sql` removed (Postgres only if volume demands).
- Nothing has run against real Vapi, Twilio or Cal.com yet.

## Excellence fix round 1 (2026-11-10), 57 tests pass
Fixed: message persistence + SMS fallback + startup refusal; narrowed STOP regex (intent forwarded + confirmed); STATE_FILE persistence; per-call summary email; tool-error alerts; /admin/status.json (+ Latest Update from docs/latest-update.md, keep both it and README in sync each round); /health reflects config; deferred after-hours text-backs; stub uses injected now; hidden caller ID omitted from bookings; over-cap without owner phone; removed check_availability/status-update/schema.sql.
Still open: deploy (Fly token / Render), live QA, backups of STATE_FILE volume (Fly snapshots), booking SMS ignores quiet hours (Legal).

## Legal fix round 2 (2026-11-10)
Done: /vapi fails closed; one opt-out gate for all caller SMS; opt-outs persist (OPTOUT_FILE, needs a Fly volume at /data); strict quiet hours; basis recorded; stub safety rules; /admin/export|delete; docs aligned; README Latest Update. 47 tests pass.
Still open: retention sweep, Postgres store, deploy, Vapi/Twilio settings and live probes (Thomas-gated accounts), USPTO check, ElevenLabs licence record.

## Needed from Thomas (today)
- Phone-only Cal.com event (15 min, no round robin, required "what do you need") → `CAL_LINK_WRIGHT_AI`.
- Vapi, Twilio, ElevenLabs accounts; Twilio number; A2P 10DLC filed.
- Transfer hours (placeholder Mon-Fri 9-5 Phoenix in `src/config/businesses.ts`).
- FAQ approval incl. pricing wording (`src/config/faq/wright-ai.ts`, also in the plan).
- QA person's name.

## Week 1 to-do (with accounts)
- Optional: move the JSON state to SQLite/Turso if volume grows (state is already persisted in STATE_FILE).
- Verify against live APIs: Vapi assistant fields and model id, the
  `<Redirect>` hand-off to Vapi's Twilio webhook, `destination` reply on
  assistant-request, end-of-call `endedReason` values, Twilio's voice-URL
  timeout before the fallback fires.
- Twilio number: voice URL `/twilio/voice`, fallback TwiML Bin dialing Thomas,
  status callback `/twilio/status`, SMS URL `/twilio/sms`.
- Half-day Vapi test against latency, transfer and fallback requirements.
- QA rows 2, 17, 23, 24, 25 on the real number with `AGENT_MODE=stub`.

## Week 2+
- Post-call price check (Sonnet) writing `price_checks`; summaries.
- Recordings to R2, 90-day sweep honouring `keep_for_demo`; demo consent.
- Dashboard; Cal.com reconciliation of unclear bookings (needs `CAL_API_KEY`).
- Mountain High roll-off flow (reuse Mountain-High-Rolloff-Bot pricing, summary, GHL handoff).

## Legal fix round 1 (2026-11-10)
- Merged the scaffold branch into main; added docs/legal/* (privacy, terms, law, contracts, vendors, messaging, claims, data inventory, breach plan); `/privacy` and `/terms` routes.
- Code: wider STOP detection, emergency/advice/promise prompt rules, disclosure version stored per call, text-back says automated + privacy link, "288 contracts / $86k" FAQ claim removed. 41 tests pass.
- Still open: Postgres store + 90-day sweep + delete-by-number command, Latest Update admin area, 10DLC, vendor accounts/settings/licences, live QA of legal prompts, transfer-leg recording notice, Mountain High agreement, legal entity facts (docs use "Wright AI Solutions, Tempe AZ" and privacy@/legal@wright-ai-solutions.com, unconfirmed).

## Excellence fix round 2 (2026-11-10)
Done: fly.toml `[mounts]`, Dockerfile /data, render.yaml; persist failures logged not fatal, startup writability check; tiered /admin/status.json (real Cal slots, watchdog unknown when off, flush heartbeat, outcome counts); weekly summary email; 90-day sweep; cost/duration stored; corrupt deferred entry dropped; single owner SMS for queued text-back; OPTOUT_FILE removed; admin auth helper; backup/rollback documented in README.
Not done (needs paid host / accounts): actual deploy and live probes, restore drill, external uptime monitor (create after deploy), lint tool, transcripts out of the hot file.
