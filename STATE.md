# STATE

## Status (2026-11-10): scaffold, not deployed
- Call path built and tested with fakes (20 tests): Twilio voice switch, Vapi
  assistant-request, booking and message tools, end-of-call text-back,
  missed-call status callback, STOP handling, kill switch (fails closed),
  daily caps, signature checks.
- Store is in memory (`src/store.ts`); Postgres replaces it in week 1.
- Nothing has run against real Vapi, Twilio or Cal.com yet.

## Needed from Thomas
- Transfer hours (placeholder: Mon-Fri 9-5 Phoenix, `src/config/businesses.ts`).
- Approved pricing wording and a check of the drafted FAQ (`src/config/faq/wright-ai.ts`).
- A phone-only Cal.com event (15 min, required "what do you need" field) → `CAL_LINK_WRIGHT_AI`.
- Accounts: Vapi, Twilio (buy a number, file A2P 10DLC day 1), ElevenLabs, Fly.io, Resend key.
- Someone other than Thomas to run the QA calls.

## Week 1 to-do
- Verify against live APIs: Vapi assistant fields and model id, the
  `<Redirect>` hand-off to Vapi's Twilio webhook, `destination` reply on
  assistant-request, end-of-call `endedReason` values.
- Half-day Vapi vs Retell test on the same script.
- Postgres store; recordings to Cloudflare R2 (90-day retention, keepers tagged).
- Twilio number: voice URL `/twilio/voice`, fallback TwiML Bin dialing Thomas,
  status callback `/twilio/status`, SMS URL `/twilio/sms`.
- Watchdog: check `/health` and Vapi every minute, flip the pause flag on failure.

## Later
- Dashboard (calls, transcripts, outcomes, metrics); post-call summary on Sonnet.
- Mountain High roll-off quote flow (reuse Mountain-High-Rolloff-Bot pricing,
  summary and GHL handoff).
