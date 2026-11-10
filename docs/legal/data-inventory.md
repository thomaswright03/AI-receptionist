# Data inventory and retention (L2, L7, L8, L9)
| Data | Source | Stored | Retention |
|---|---|---|---|
| Phone number, call metadata | Twilio/Vapi | Postgres (in-memory in pilot) | 12 months |
| Recording | Vapi | Vapi, R2 planned | 90 days |
| Transcript, summary | Vapi/LLM | Postgres | 12 months |
| Booking name, email, reason | caller | Cal.com, Postgres | 12 months |
| Text logs, opt-out status | Twilio | Postgres | 12 months; opt-outs kept to honour them |
| Call audio (live) | Twilio/Vapi | Deepgram (speech-to-text, via Vapi); not kept by us | per Deepgram terms; settings to be recorded |
| Caller name, number, email, need | caller | Resend email and SMS copies to the owner; Cal.com invite | owner's mailbox/phone; deleted on request |
| Message content (take_message) | caller | Owner email (Resend) and urgent SMS | owner's mailbox/phone; 12 months |
| Service logs (events, dry-run texts) | service | Fly.io logs | provider default, a few days |
| Disclosure and text basis record | service | Postgres call record | 12 months |
Deletion: on request to privacy@wright-ai-solutions.com the operator runs `POST /admin/export` or `/admin/delete` (by phone number) for the service store, then removes the number in Vapi, Cal.com, Twilio logs and the owner's email within 30 days. Runbook: export first, send it to the requester after verifying control of the number, then delete. Opt-out status is kept so the number is never texted. The automated 90-day/12-month sweep is a build item (STATE.md) and is Thomas-gated for Vapi retention until the account exists.
