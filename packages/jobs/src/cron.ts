/**
 * A five-field cron parser, in UTC.
 *
 * Written rather than pulled in: the whole surface we need is "is this
 * expression valid" and "when does it next fire", which is ~80 lines, and a
 * schedule that silently means something different after a dependency bump is
 * worse than one we can read.
 *
 *   ┌── minute (0-59)
 *   │ ┌── hour (0-23)
 *   │ │ ┌── day of month (1-31)
 *   │ │ │ ┌── month (1-12)
 *   │ │ │ │ ┌── day of week (0-6, Sunday = 0; 7 also accepted)
 *   * * * * *
 *
 * Supported per field: `*`, `n`, `a-b`, lists (`a,b,c`), and steps on any of
 * those (`* / n`, `a-b/n`). Named months/days are not supported — numbers only,
 * so an expression means the same thing in every locale.
 */

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface Fields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Standard cron: when both day fields are restricted, either one matching fires. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Throws on anything malformed — a schedule that never fires is worse than one that fails loudly. */
export function parseCron(expression: string): Fields {
  const normalized = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression needs 5 fields, got ${parts.length}: "${expression}"`);
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(month, 1, 12),
    // 7 and 0 are both Sunday; normalise so matching only has to check one.
    daysOfWeek: new Set([...parseField(dow, 0, 7)].map((d) => d % 7)),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first firing strictly after `from`, in UTC. Returns null if nothing
 * matches within four years — the only expressions that manage that are
 * impossible dates like `0 0 30 2 *` (30th of February).
 */
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  const fields = parseCron(expression);

  // Start at the next whole minute: a schedule fires on minute boundaries, and
  // "strictly after" keeps a tick from re-firing the schedule it just ran.
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const limit = 4 * 366 * 24 * 60;
  for (let step = 0; step < limit; step++) {
    if (matches(fields, cursor)) return new Date(cursor);

    // Whole days can be skipped when the date itself cannot match — that turns
    // "0 0 1 1 *" from a million minute-checks into a few thousand day-checks.
    if (!matchesDate(fields, cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return null;
}

function matches(fields: Fields, date: Date): boolean {
  return (
    matchesDate(fields, date) &&
    fields.hours.has(date.getUTCHours()) &&
    fields.minutes.has(date.getUTCMinutes())
  );
}

function matchesDate(fields: Fields, date: Date): boolean {
  if (!fields.months.has(date.getUTCMonth() + 1)) return false;

  const domHit = fields.daysOfMonth.has(date.getUTCDate());
  const dowHit = fields.daysOfWeek.has(date.getUTCDay());

  // Both restricted means OR, per every other cron implementation: "1 * * 1 5"
  // is the 1st *and* every Friday, not Fridays that fall on the 1st.
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    if (stepText !== undefined && !/^\d+$/.test(stepText)) {
      throw new Error(`invalid step in cron field: "${part}"`);
    }
    const step = stepText ? Number(stepText) : 1;
    if (step < 1) throw new Error(`cron step must be >= 1: "${part}"`);

    let start: number;
    let end: number;

    if (range === "*" || range === undefined) {
      start = min;
      end = max;
    } else if (/^\d+$/.test(range)) {
      start = Number(range);
      // A bare number with a step is open-ended ("5/10" = 5,15,25,…).
      end = stepText ? max : start;
    } else {
      const bounds = range.split("-");
      if (bounds.length !== 2 || !bounds.every((b) => /^\d+$/.test(b))) {
        throw new Error(`invalid cron field: "${part}"`);
      }
      start = Number(bounds[0]);
      end = Number(bounds[1]);
    }

    if (start < min || end > max || start > end) {
      throw new Error(`cron field "${part}" is out of range ${min}-${max}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) throw new Error(`cron field matched nothing: "${field}"`);
  return values;
}
