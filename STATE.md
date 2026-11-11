# STATE

AI phone receptionist for small businesses (Hono/TypeScript). Twilio voice switch -> Vapi agent; FAQ, Cal.com booking, transfer (with fallback), text-back for missed calls. Pilot: Wright AI's own line, then Mountain High Disposal (flow added, placeholder content). Never run against real Vapi/Twilio/Cal.com.

## Status (2026-11-11, excellence fix round 4)
90 tests pass; lint, coverage (95.6% lines), build, `npm run smoke` pass; CI runs smoke.
Deployed in dry-run (stub agent, free Render, no disk): https://ai-receptionist-dryrun.onrender.com, service srv-dbptj0u7bikc73bcmm10. `/health` 200. Outside monitor: `.github/workflows/uptime.yml` (every 15 min, repo variable DEPLOY_URL).
Round 4 fixed: transfer fallbackPlan + unanswered-transfer outcome; missed-call owner notice falls back to email and failure is recorded; reconcile job closes calls with no end-of-call report after 20 min; status rows (Twilio, Resend, Vapi, Kill switch, Latest backup, Owner alerts, Unfinished calls) in `src/statusJson.ts`; honest texting window, Hawaii/Alaska not queued, one owner SMS per queued text-back; owner HELP, owner STOP warning, `docs/owner-guide.md` (sent with first weekly summary); prompt "by email"/routine no-email; Mountain High flow/business (active when MOUNTAIN_HIGH_NUMBER set); `npm run eval` (not yet run: needs ANTHROPIC_API_KEY); APP_VERSION set at deploy; latest-update newest first.

## Decisions
- State is a JSON file on a persistent volume (`STATE_FILE`); SQLite/Turso only if volume demands.
- Urgent vs routine alerts: owner SMS if a phone exists, else email (alertOwner in src/alerts.ts).
- Kill switch: owner PAUSE/RESUME/STATUS/HELP by text, `KILL_SWITCH`, remote flag, watchdog.
- Lost end-of-call reports are treated as missed calls (no Vapi API fetch: no account).

## Next steps
- Paid persistent-disk host (Thomas approves), then a snapshot restore drill and a README entry.
- Vapi/Twilio/ElevenLabs accounts, A2P 10DLC, live QA (docs/qa-cases.md); verify Vapi transferPlan field names and the transfer end-reason strings (row 17).
- Run `npm run eval` with an Anthropic key; record results.
- FAQ/pricing approval, transfer hours, Cal.com event; Mountain High facts; legal items.

## Open problems
- Nothing verified live. Free Render host sleeps when idle and has no disk, so state is lost on restart.
