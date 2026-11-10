## Latest Update (2026-11-10, fix round 1)
- No frontend changes (there is no web UI). The owner-facing status area is `GET /admin/status.json` (Bearer `ADMIN_SECRET`): version, kill switch, watchdog, last call time, queued text-backs, config present, Cal.com reachability and this section.
- Caller messages are saved on the call record before any notification; email failure falls back to SMS and is logged; `DRY_RUN=false` refuses to start without an owner email and `STATE_FILE`.
- STOP detection narrowed: only carrier keywords and clear "stop texting me" phrases opt out; the latter are forwarded to the owner as a possible opt-out and confirmed to the sender. "yes" is no longer a START word, so it reaches the owner.
- All state (calls, messages, PAUSE flag, booking keys, caps, opt-outs) persists in `STATE_FILE` (put on a volume).
- The owner gets a summary email per call; tool errors text the owner; `/health` returns 503 when live config is missing.
- Missed calls outside texting hours are queued and sent when the window opens (within 24 h).
- Booking omits an unknown caller number and keys on the call id; over-cap calls without an owner phone get message-taking only; removed the unused `check_availability` and `status-update` and the unused `db/schema.sql`.
