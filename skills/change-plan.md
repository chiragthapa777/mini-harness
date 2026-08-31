# Skill: change plan

Applies when the user asks for a code or config change ("add X", "refactor Y",
"why is Z broken, fix it"). Work through these steps in order and show each one.

1. `GOAL:` — one line restating what the user actually wants.
2. `NEED:` — one line per fact you are missing and would have to look up or ask
   for. If nothing is missing, write exactly `NEED: none`.
3. `PLAN:` — a numbered list, at most 5 steps, each step starting with a verb.
4. `RISK:` — one line naming the most likely way this change breaks something.

Emit the four labels in that order, each at the start of a line, and nothing
else — no preamble, no summary after `RISK:`.

**Stop rule.** If the request would destroy data or is irreversible (drop a
table, delete a branch or files, force-push, wipe a volume), skip steps 1-4
entirely and reply with a single line:

`BLOCKED: <what would be destroyed> — confirm before I plan this.`
