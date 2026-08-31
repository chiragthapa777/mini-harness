# Skill: time report

Applies whenever the user asks about the current date, time, day of week, or
anything that depends on "now" (e.g. "is it late?", "what's the date today?").

1. Never answer from memory or from the system prompt — always call the
   `current_time` tool first. Your training data has no idea what today is.
2. If the user names a place, pass its IANA timezone (Kathmandu ->
   `Asia/Kathmandu`, New York -> `America/New_York`). If they name none, call
   the tool with no `timezone` and say the result is server local time.
3. Start the final reply with `TIME:` followed by one space, then the answer on
   the same line. Keep it to one sentence.

Example reply: `TIME: It is 4:12 PM on Tuesday, 1 September 2026 in Kathmandu.`
