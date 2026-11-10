# STATE

## Status (2026-11-10): matches the final plan, not deployed
Plan: https://claude.ai/artifact/91wucVfWdBXVbStkszR8Ta (final 2026-11-10; next change only after QA row 25 passes).

- Built and tested with fakes (32 tests): Twilio voice switch with a fail-closed
  1.5 s pause check; owner PAUSE/RESUME/STATUS by text with confirmations;
  watchdog with 3-fail trip / 3-success restore and owner texts; week-1 stub
  agent (`AGENT_MODE=stub`); full assistant with disclosure first, FAQ, transfer
  rules, open times preloaded; idempotent booking; urgent vs routine alerts;
  missed-call text-back; STOP; caps; signature checks; per-dependency timeouts.
- `db/schema.sql` loads cleanly on Postgres 16; the code still uses the
  in-memory store (`src/store.ts`).
- Nothing has run against real Vapi, Twilio or Cal.com yet.

## Needed from Thomas (today)
- Phone-only Cal.com event (15 min, no round robin, required "what do you need") → `CAL_LINK_WRIGHT_AI`.
- Vapi, Twilio, ElevenLabs accounts; Twilio number; A2P 10DLC filed.
- Transfer hours (placeholder Mon-Fri 9-5 Phoenix in `src/config/businesses.ts`).
- FAQ approval incl. pricing wording (`src/config/faq/wright-ai.ts`, also in the plan).
- QA person's name.

## Week 1 to-do (with accounts)
- Postgres store implementing `Store` against `db/schema.sql`; switches and
  booking keys move there (in memory they reset on deploy).
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
