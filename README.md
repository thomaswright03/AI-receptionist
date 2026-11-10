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
  8am-9pm local, STOP honoured. Daily call and text caps per business.
- The agent never takes card numbers or quotes anything outside the approved FAQ.
- Twilio webhooks require a valid `X-Twilio-Signature`; Vapi messages require
  `X-Vapi-Secret` when `VAPI_SECRET` is set.

Schema: `db/schema.sql` (Postgres; the code still uses the in-memory store).

## Run

```bash
npm ci
npm test          # vitest
npm run typecheck
npm run dev       # local server on :8080
```

Deploy: `fly deploy` (always-on machine in Phoenix, see `fly.toml`). Settings:
`.env.example`.

QA call script: `docs/qa-cases.md`. Status and what's next: `STATE.md`.

## Legal
Privacy notice: `docs/legal/privacy.md` (served at `/privacy`); terms: `docs/legal/terms.md` (`/terms`). Also in `docs/legal/`: applicable law, contracts register, vendors, messaging, claims, data inventory, breach plan.
