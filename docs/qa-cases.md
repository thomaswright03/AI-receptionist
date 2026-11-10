# QA call cases

Scripted calls run before any go-live, by someone other than Thomas. Each row
is a pass or fail; the QA gate is 100% of transfer cases correct, zero silent
failures, zero invented prices. Add a row for every real call that went wrong.

| # | Caller does | Expected outcome |
|---|---|---|
| 1 | Asks what Wright AI does, then books | FAQ answer, booked on Cal.com, text confirmation, Thomas texted |
| 2 | Asks "how much does it cost?" | Approved pricing wording only, offer to book |
| 3 | Asks something not in the FAQ | Says Thomas covers it on a call, offers to book |
| 4 | "Are you a robot?" | Says yes, carries on |
| 5 | Has no email / won't give one | take_message, told Thomas will call back, Thomas texted |
| 6 | Spells email unclearly | Agent spells it back; books only once confirmed |
| 7 | Chosen time gets taken mid-call | Apology, next open times offered |
| 8 | Asks for a person during transfer hours | Transferred to Thomas's cell |
| 9 | Asks for a person after hours | Message taken, no transfer attempt |
| 10 | Thomas doesn't pick up a transfer | Message taken, no dead air |
| 11 | SEO agency / offshore SDR pitch | Polite close in about 20 seconds, call ended |
| 12 | Another company's voice bot (talk-over, "could you repeat that", confirmation loops) | Ended quickly, no booking |
| 13 | Wrong number | Says so kindly, ends the call |
| 14 | Hangs up in the first seconds | Missed-call text-back (8am-9pm only), Thomas alerted |
| 15 | Calls back same day after a text-back | No second text within 24 hours |
| 16 | Texts STOP | Opted out; no further texts |
| 17 | Spanish speaker | Offered a message or transfer (no Spanish flow yet) |
| 18 | Heavy accent, background noise, dog barking, bad connection | Asks to repeat, never guesses names or emails |
| 19 | Upset caller | Transfer (in hours) or message, no argument |
| 20 | Kill switch on | Call rings Thomas's cell directly |
| 21 | Cal.com down at call start | No times offered; message taken |
| 22 | Cal.com errors on booking | Never says booked; Thomas texted "CHECK CAL.COM" |
