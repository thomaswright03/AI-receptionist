# Messaging classification (MSG1, MSG2, MSG3, MSG5)
- Missed-call text-back is a transactional reply to the caller's own inbound call: one text, identifies sender, says it's automated, no promotion, includes STOP wording and the privacy link. Basis recorded as `reply_to_inbound_call` with the call id on the call record.
- Booking confirmations are transactional.
- No marketing content may ever go through this service. 10DLC campaign: use case "customer care", sample message is the text-back text; registration needs the privacy URL (`/privacy`).
- Sending: 8am to 9pm recipient-local time, US numbers only, max one per number per 24h, daily cap, kill switch.
- Opt-out: keywords STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, plus plain requests ("stop texting me"). Opted-out numbers get nothing further (tested).
