# AI Receptionist

An AI phone receptionist for small businesses: answers every call in a
natural voice, answers questions from an approved FAQ, books appointments,
transfers to a person when needed, and texts back callers it missed.

First business: **Wright AI Solutions** (books discovery calls on Cal.com).
Next: Mountain High Disposal's after-hours roll-off line.
Plan: https://claude.ai/artifact/91wucVfWdBXVbStkszR8Ta

## How a call flows

1. Caller dials the business's **Twilio number**. Its voice URL is
   `POST /twilio/voice` on this service, which either hands the call to Vapi
   (`<Redirect>` to Vapi's Twilio webhook) or, when the agent is paused,
   dials the owner. The number's **Voice Fallback URL** is a static TwiML Bin
   that dials the owner, so calls still reach a person if this service is down.
2. Vapi asks this service for the assistant (`assistant-request` on
   `POST /vapi`). We build it per call: prompt with the business's FAQ, the
   flow's questions, the next 15 open Cal.com times, and transfer allowed only
   inside transfer hours. Live model: Claude Haiku (fast); voice: ElevenLabs.
3. Mid-call, the agent calls our tools (`book_discovery_call`,
   `take_message`) on `POST /vapi`. Bookings are re-checked by Cal.com; a slot
   taken meanwhile is re-offered, an unclear answer is never reported as
   booked and Thomas is texted to check.
4. After the call (`end-of-call-report`), a call that failed before the
   caller got anywhere triggers a missed-call text-back. Twilio's call-status
   callback (`POST /twilio/status`) does the same for busy / no-answer /
   failed calls that never reached the agent.

Config is shaped **business → flow → shared tools**: `src/config/businesses.ts`,
`src/flows/`, and the tool code in `src/vapi/handler.ts`.

## Kill switch, watchdog and fallback

A pause sends **new** calls to the owner's cell; calls already with the agent
finish. Any one switch set means paused; all must be clear for the agent to
answer, and a pause overrides transfer hours.

| Switch | Set by | Cleared by |
|---|---|---|
| Owner pause | Owner texts `PAUSE` to the business number from their own cell (confirmed by reply; `STATUS` shows state) | `RESUME` |
| Service-wide | `KILL_SWITCH=on` (or remote `KILL_SWITCH_URL` not saying `{"paused": false}`) | Setting it back |
| Watchdog | 3 failed checks in a row of `WATCHDOG_URLS` (texts the owner) | 3 good checks in a row (texts again) |

The whole pause check has a 1.5-second budget; a timeout or error counts as
paused. If this service is down, the Twilio number's Voice Fallback URL (a
static TwiML Bin dialing the owner) answers instead.

## Other safety rules

- `DRY_RUN=true` (default) logs texts and emails instead of sending.
- `AGENT_MODE=stub` (week 1): the agent only discloses and hands off.
- The first sentence says it's an AI and the call is recorded.
- Transfer rules in the prompt (`TRANSFER_TRIGGERS`): a request for a person,
  complaints, billing, legal, harm, large jobs, Spanish. Transfer happens with
  no confirming question; outside transfer hours, a message is taken instead.
- Bookings are idempotent: one Cal.com attempt per key and one booking per
  call; an unclear answer is never retried or reported as booked.
- Owner texts only for what needs action now (failed/unclear bookings, urgent
  messages, missed calls, watchdog); bookings and routine messages go to email.
- Text-backs: a one-time reply to the caller's own call, once per 24 hours,
  STOP honoured. Only sent when it is 8am-9pm for the caller; we check the business zone plus Eastern and Pacific, so for Phoenix that is about 9am-7pm in winter and 8am-6pm in summer. Hawaii and Alaska numbers are never texted (the owner is told). Daily call and text caps per business.
- The agent never takes card numbers or quotes anything outside the approved FAQ.
- Twilio webhooks require a valid `X-Twilio-Signature`; Vapi messages require
  `X-Vapi-Secret` when `VAPI_SECRET` is set.

State: a JSON file (`STATE_FILE`) on a persistent volume; swap in Postgres behind the `Store` interface when volume grows.

## Run

```bash
npm ci
npm test          # vitest
npm run lint      # strict typecheck (unused code is an error)
npm run coverage  # tests with a coverage floor (CI enforces it)
npm run typecheck
npm run dev       # local server on :8080
```

Smoke test (also in CI): `npm run build && npm run smoke` boots the server in dry-run with a temp state file, checks `/health`, and stops it. Eval of the live prompt (on demand, needs `ANTHROPIC_API_KEY`): `npm run eval`, results in `docs/eval-results/`. Owner guide: `docs/owner-guide.md`.

Deploy (paid persistent-disk host not yet approved; see "Deployment record" below): on Fly, `fly volumes create receptionist_data --region phx --size 1` once, then `fly deploy` (`fly.toml` mounts the volume at `/data`). On Render, use `render.yaml` (persistent disk at `/data`, paid plan). Settings: `.env.example`. With `DRY_RUN=false` the service refuses to start if the state directory isn't writable; with it unwritable in dry-run, writes are logged (`store.persist.failed`) and `/admin/status.json` shows "State storage: down".

### Deployment record
Free dry-run deploy (Render free tier, stub agent, `DRY_RUN=true`, no disk, `STATE_FILE` unset): https://ai-receptionist-dryrun.onrender.com (service `srv-dbptj0u7bikc73bcmm10`, deployed 2026-11-11, `/health` returns 200). Monitor: the GitHub `Uptime` workflow (every 15 minutes, repo variable `DEPLOY_URL`). Rollback: Render dashboard, Deploys, "Rollback" to the previous deploy. The free tier sleeps when idle and is for proving boot only, not for live calls. Set `APP_VERSION` to the commit on every deploy (Fly: `fly deploy --env APP_VERSION=$(git rev-parse --short HEAD)`; Render: env var). Backup marker: the host's snapshot job may touch `<STATE_FILE>.backup`; `/admin/status.json` "Latest backup" reads its time (Unknown until then). Restore drill: not done yet (needs the disk host).

### Backups, restore, rollback
- State is one JSON file (`STATE_FILE`). Fly takes daily volume snapshots (14 days kept); on Render enable disk snapshots. Worst-case data loss: up to 24 h of messages, calls and opt-outs.
- Restore: `fly volumes create receptionist_data_restore --snapshot-id <id>` then point a scratch app at it, check `/admin/status.json`, and swap. Expect about 15 minutes. (Never drilled yet: needs a live host.)
- Rollback: `fly deploy --image <previous image ref>` (see `fly releases`), or Render's "Rollback" on the previous deploy.
- Outside alert: `.github/workflows/uptime.yml` curls `<DEPLOY_URL>/health` every 15 minutes and fails (GitHub emails the repo owner) when it is down; set the repo variable `DEPLOY_URL`. The failure email goes to the GitHub account that owns the repo (thomaswright03). The timeout is 90 s because free Render takes 30-60 s to wake. A dedicated monitor (e.g. UptimeRobot) with SMS is better. Point it (e.g. UptimeRobot) at `/health` with email/SMS to the owner; the in-process watchdog cannot report its own death. `/admin/status.json` marks the text-back job `down` if it hasn't run in 3 minutes.
- Retention: calls and events older than 90 days are swept every 6 hours. Caps ("per day") are a rolling 24 hours.

QA call script: `docs/qa-cases.md`. Status and what's next: `STATE.md`.

## Legal
Privacy notice: `docs/legal/privacy.md` (served at `/privacy`); terms: `docs/legal/terms.md` (`/terms`). Also in `docs/legal/`: applicable law, contracts register, vendors, messaging, claims, data inventory, breach plan.

## Latest Update (2026-11-11, fix round 4)
- No frontend changes (there is no web UI). Owner-facing changes:
- A transfer the owner doesn't answer now comes back to the receptionist, who takes a message (urgent) and the owner is alerted; the call shows as "missed, texted back", not "passed to a person".
- Every missed call reaches the owner by text, or by email if the text can't be sent or there is no owner phone. If both fail it is logged and the status page shows "Owner alerts: down".
- A call whose final report never arrives is closed after 20 minutes by a background job: the caller is texted back (if allowed) and the owner told. Status shows "Unfinished calls" and the job.
- `/admin/status.json` has Twilio, Resend, Vapi, Kill switch, Latest backup, Owner alerts and Unfinished calls rows.
- Texting window stated honestly (about 9am-7pm Phoenix in winter, 8am-6pm in summer). Hawaii and Alaska numbers are reported to the owner at once instead of queued; a queued text-back that expires tells the owner by email. The owner is texted once per queued missed call.
- Owner can text HELP; STOP from the owner is ignored with a warning. New `docs/owner-guide.md`, sent with the first weekly summary.
- A caller with no email is a routine message (no instant text). Prompt says "by email" when the owner has no phone.
- Mountain High Disposal roll-off flow and business added (placeholder content, active once `MOUNTAIN_HIGH_NUMBER` is set).
- `npm run eval` (on demand), `npm run smoke` (CI boots the server), uptime workflow for `/health`.

## Earlier update (2026-11-11, fix round 3)
- No frontend changes in this round.
- Callers who reach the missed-call message now hear "We'll get back to you as soon as we can" (no promise of a text). Booking and tool-error alerts fall back to email when there is no owner phone, and the agent says "by email" then.
- Status: STATUS by text and the weekly email now say in plain words what happened in the last 24 hours, how many text-backs are waiting, and anything broken. `/admin/status.json` uses the standard shape (`overall`, `checked_at`, `functions[]` with `tier`), has a row per scheduled job (last success, next run, last error), and Important rows for "Calls answered" and "Messages delivered". A job is "ok" only after it finishes; a failing one shows Down with its error.
- Weekly summary goes out once per local Monday (it used to repeat at 5pm Phoenix time).
- State writes are now batched and run in the background; transcripts are kept in separate files; heartbeats never touch the disk. The retention sweep also removes booking keys and last-call times. Call summary emails use plain words.
- CI runs `npm run lint` and a coverage floor.

## Earlier update (2026-11-10, fix round 2)
- No frontend changes (no web UI). `GET /admin/status.json` now uses Important/Key/Basic tiers with ok/warning/down/unknown per function plus last_checked/last_success/next_expected_run; Cal.com is checked against the real event's slots; the watchdog shows "unknown" when off; outcome counts (today, 7 days) per business.
- A failed disk write no longer fails a call (logged, shown in status); startup checks the state directory; fly.toml mounts `/data`; render.yaml added; Dockerfile creates `/data`.
- Weekly outcome email to the owner; 90-day retention sweep; call cost and duration stored from Vapi's report; a corrupt queued text-back is dropped instead of blocking the rest; deferred text-backs send the owner one SMS instead of two; redundant `OPTOUT_FILE` removed.

## Earlier update (2026-11-10, fix round 1)
- No frontend changes (there is no web UI). The owner-facing status area is `GET /admin/status.json` (Bearer `ADMIN_SECRET`): version, kill switch, watchdog, last call time, queued text-backs, config present, Cal.com reachability and this section.
- Caller messages are saved on the call record before any notification; email failure falls back to SMS and is logged; `DRY_RUN=false` refuses to start without an owner email and `STATE_FILE`.
- STOP detection narrowed: only carrier keywords and clear "stop texting me" phrases opt out; the latter are forwarded to the owner as a possible opt-out and confirmed to the sender. "yes" is no longer a START word, so it reaches the owner.
- All state (calls, messages, PAUSE flag, booking keys, caps, opt-outs) persists in `STATE_FILE` (put on a volume).
- The owner gets a summary email per call; tool errors text the owner; `/health` returns 503 when live config is missing.
- Missed calls outside texting hours are queued and sent when the window opens (within 24 h).
- Booking omits an unknown caller number and keys on the call id; over-cap calls without an owner phone get message-taking only; removed the unused `check_availability` and `status-update` and the unused `db/schema.sql`.
