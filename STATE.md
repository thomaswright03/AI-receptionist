# STATE

AI phone receptionist for small businesses (Hono/TypeScript). Twilio voice switch -> Vapi agent; FAQ, Cal.com booking, transfer, text-back for missed calls. Pilot: Wright AI's own line, then Mountain High Disposal after hours (that flow is not built). Not deployed; never run against real Vapi/Twilio/Cal.com.

## Status (2026-11-11, excellence fix round 3)
71 tests pass; `npm run lint`, `npm run coverage` (floor enforced in CI), `npm run build` pass.
Round 3 fixed: neutral missed-call wording; owner alerts fall back to email (no owner phone); job heartbeats recorded only on success, errors shown Down; weekly summary keyed on local Monday; batched async state writes, transcripts in `<STATE_FILE>.transcripts/`, `mem:` flags never persisted; sweep removes booking/last-call flags; standard status JSON with job rows and Calls answered / Messages delivered rows; plain-language STATUS text and weekly email; plain labels in call emails; stale comments and `abandoned` outcome removed.

## Decisions
- State is a JSON file on a persistent volume (`STATE_FILE`); SQLite/Turso only if volume demands.
- Urgent vs routine alerts: owner SMS if a phone exists, else email.
- Kill switch: owner PAUSE/RESUME/STATUS by text, `KILL_SWITCH`, remote flag, watchdog (3 fail / 3 ok).

## Next steps
- Deploy in DRY_RUN with the stub agent (needs a paid host with a persistent disk: Thomas's approval), add an outside uptime monitor on `/health`, practise a snapshot restore and write it in the README.
- Vapi/Twilio/ElevenLabs accounts, A2P 10DLC, live QA (docs/qa-cases.md), verify field names marked "verify".
- FAQ/pricing approval, transfer hours, Cal.com phone-only event (`CAL_LINK_WRIGHT_AI`).
- Mountain High roll-off flow; legal facts and agreement (see docs/legal/).

## Open problems
- Nothing verified live; scheduler wiring in `src/server.ts` is not unit tested (excluded from coverage).
