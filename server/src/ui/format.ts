/** Presentation helpers shared by the dashboard. Pure — no DOM. */

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

// e.g. "Aug 3, 1:09am (UTC)" or "Aug 7, 8pm (UTC)"
const RESET = /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)$/i;

const HALF_YEAR_MS = 182 * 24 * 60 * 60 * 1000;

export interface ResetTimeOptions {
  /** Reference point for inferring the year; defaults to now. */
  now?: Date;
  /** IANA zone to render in; defaults to the viewer's. */
  timeZone?: string;
  locale?: string;
}

/**
 * Parse a Claude CLI reset time, which is always UTC and carries no year.
 * Returns null when the text isn't in the expected shape.
 */
export function parseResetTime(resetsAt: string, now: Date = new Date()): Date | null {
  const match = RESET.exec(resetsAt.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase());
  if (month === -1) return null;

  const day = Number(match[2]);
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  const meridiem = match[5]!.toLowerCase();
  let hour = Number(match[3]) % 12;
  if (meridiem === 'pm') hour += 12;

  // No year in the text: assume the occurrence nearest to now, so a window
  // resetting in early January reads correctly when seen in December.
  const year = now.getUTCFullYear();
  let stamp = Date.UTC(year, month, day, hour, minute);
  if (stamp - now.getTime() > HALF_YEAR_MS) stamp = Date.UTC(year - 1, month, day, hour, minute);
  else if (now.getTime() - stamp > HALF_YEAR_MS) stamp = Date.UTC(year + 1, month, day, hour, minute);
  return new Date(stamp);
}

/**
 * Render a UTC reset time in the viewer's own time zone, e.g.
 * "Aug 3, 1:09am (UTC)" -> "Aug 2, 6:09pm PDT". Unparseable input is
 * passed through unchanged rather than hidden.
 */
export function localResetTime(resetsAt: string, opts: ResetTimeOptions = {}): string {
  const parsed = parseResetTime(resetsAt, opts.now ?? new Date());
  if (parsed === null) return resetsAt;
  const formatted = parsed.toLocaleString(opts.locale ?? 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
  });
  // Match the CLI's compact lowercase meridiem: "6:09 PM" -> "6:09pm".
  return formatted.replace(/\s(AM|PM)\b/, (_, m: string) => m.toLowerCase());
}
