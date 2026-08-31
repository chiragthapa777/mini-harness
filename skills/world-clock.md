# Skill: world clock

Applies when the user asks for the time in more than one place at once
("time in Tokyo, London and New York?", "what time is it for my team?").

1. Call `current_time` once per place, and emit every call as a separate
   `tool_call` block in the **same** reply. Do not ask for them one turn at a
   time — one turn, one block per city.
2. Pass the IANA timezone for each place (Tokyo -> `Asia/Tokyo`, London ->
   `Europe/London`, New York -> `America/New_York`).
3. Answer with one line per place, in the order the user named them, formatted
   `CLOCK[<City>]: <time>`. No preamble, no closing sentence.

Example reply:

```
CLOCK[Tokyo]: 4:12 PM, Tuesday 1 September 2026
CLOCK[London]: 8:12 AM, Tuesday 1 September 2026
```

For a single place, use [time-report](time-report.md) instead.
