# Data inventory and retention (L2, L7, L8, L9)
| Data | Source | Stored | Retention |
|---|---|---|---|
| Phone number, call metadata | Twilio/Vapi | Postgres (in-memory in pilot) | 12 months |
| Recording | Vapi | Vapi, R2 planned | 90 days |
| Transcript, summary | Vapi/LLM | Postgres | 12 months |
| Booking name, email, reason | caller | Cal.com, Postgres | 12 months |
| Text logs, opt-out status | Twilio | Postgres | 12 months; opt-outs kept to honour them |
| Disclosure and text basis record | service | Postgres call record | 12 months |
Deletion: on request to privacy@wright-ai-solutions.com the operator deletes by phone number in Postgres, R2, Vapi and Twilio logs within 30 days. The automated sweep and a delete-by-number command are build items (STATE.md).
