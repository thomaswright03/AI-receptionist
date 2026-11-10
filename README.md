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

## Safety

- `DRY_RUN=true` (default) logs texts and emails instead of sending.
- `KILL_SWITCH=on`, or a remote `KILL_SWITCH_URL` returning anything but
  `{"paused": false}` (including unreachable), sends every call to the owner.
- Per-business daily call and text caps; over the call cap, calls go to the owner.
- Text-backs: once per caller per 24 hours, 8am-9pm local only, STOP honoured.
- The agent never takes card numbers, never invents prices, and discloses it
  is an AI and that calls are recorded.
- Twilio webhooks require a valid `X-Twilio-Signature`; Vapi messages require
  `X-Vapi-Secret` when `VAPI_SECRET` is set.

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
