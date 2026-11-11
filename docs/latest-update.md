## Latest Update (2026-11-11, fix round 3)
- No frontend changes in this round.
- Callers who reach the missed-call message now hear "We'll get back to you as soon as we can" (no promise of a text). Booking and tool-error alerts fall back to email when there is no owner phone, and the agent says "by email" then.
- Status: STATUS by text and the weekly email now say in plain words what happened in the last 24 hours, how many text-backs are waiting, and anything broken. `/admin/status.json` uses the standard shape (`overall`, `checked_at`, `functions[]` with `tier`), has a row per scheduled job (last success, next run, last error), and Important rows for "Calls answered" and "Messages delivered". A job is "ok" only after it finishes; a failing one shows Down with its error.
- Weekly summary goes out once per local Monday (it used to repeat at 5pm Phoenix time).
- State writes are now batched and run in the background; transcripts are kept in separate files; heartbeats never touch the disk. The retention sweep also removes booking keys and last-call times. Call summary emails use plain words.
- CI runs `npm run lint` and a coverage floor.

## Earlier update (2026-11-10, fix round 1)
- No frontend changes (there is no web UI). The owner-facing status area is `GET /admin/status.json` (Bearer `ADMIN_SECRET`): version, kill switch, watchdog, last call time, queued text-backs, config present, Cal.com reachability and this section.
- Caller messages are saved on the call record before any notification; email failure falls back to SMS and is logged; `DRY_RUN=false` refuses to start without an owner email and `STATE_FILE`.
- STOP detection narrowed: only carrier keywords and clear "stop texting me" phrases opt out; the latter are forwarded to the owner as a possible opt-out and confirmed to the sender. "yes" is no longer a START word, so it reaches the owner.
- All state (calls, messages, PAUSE flag, booking keys, caps, opt-outs) persists in `STATE_FILE` (put on a volume).
- The owner gets a summary email per call; tool errors text the owner; `/health` returns 503 when live config is missing.
- Missed calls outside texting hours are queued and sent when the window opens (within 24 h).
- Booking omits an unknown caller number and keys on the call id; over-cap calls without an owner phone get message-taking only; removed the unused `check_availability` and `status-update` and the unused `db/schema.sql`.

## Earlier update (2026-11-10, fix round 2)
- No frontend changes in this round.
- Status JSON in tiered format with real Cal.com slot check and outcome counts; disk-write failures no longer fail calls; fly.toml/render.yaml/Dockerfile persist `/data`; weekly owner summary; 90-day sweep; cost and duration stored per call; corrupt queued text-back dropped; one owner SMS for a queued text-back.
