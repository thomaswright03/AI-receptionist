# Vendors, data flows, and settings (PP4, AI1, AI6, L15, L20)
| Vendor | Gets | Settings to apply and record when account exists |
|---|---|---|
| Twilio | number, call audio path, SMS | no extra recording in Twilio; US region |
| Vapi | audio, transcript, summary | HIPAA/zero-retention off unless needed; recording retention set to 90 days; no training |
| Deepgram (via Vapi) | live call audio for transcription | no training / no retention where offered |
| Resend | owner alert emails (caller name, number, email, need) | none beyond default |
| ElevenLabs | reply text for speech | zero-retention mode; no training |
| LLM (Anthropic via Vapi) | transcript text, prompt | API terms: no training on inputs |
| Cal.com | name, email, reason, time | booking data only |
| Fly.io / Postgres / R2 (planned) | all stored data | encrypted at rest, US region |
Voice: a stock ElevenLabs library voice ("sarah") is used, never a clone of a real person; record the licence page and date when the account is created. Flowdown: Twilio and Vapi acceptable-use rules are in terms.md §2 and §12.
Asset list: no logos, images or third-party content; product name "AI Receptionist" is generic and not a registered mark; run a USPTO check before any branded launch.
Settings status: NOT YET APPLIED (no accounts). Tick when done.
