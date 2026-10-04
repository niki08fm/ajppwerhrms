/**
 * One set of names for a day, used by the Today cards and the Attendance filter chips,
 * so HR sees the same word and the same number on both screens. The server counts them
 * the same way (backend/src/services/dayview.service.js).
 *
 * Colours carry one meaning each: teal is fine, amber needs a look, red is a problem,
 * grey is neutral.
 */
export const TONE = {
  ok: 'var(--primary)',
  warn: 'var(--warning)',
  bad: 'var(--destructive)',
  muted: 'var(--muted-foreground)',
  soft: 'color-mix(in srgb, var(--primary) 30%, var(--card))',
};

/** The views in card order. `today` and `past` give the words for a live day and a closed one. */
export const VIEW_DEFS = [
  { key: 'in', today: 'In today', past: 'Came in', subToday: 'expected today', subPast: 'expected that day', tone: null },
  { key: 'onsite', today: 'On site now', past: null, subToday: 'still punched in', tone: 'ok', todayOnly: true },
  { key: 'nopunch', today: null, past: 'No punch-out', subPast: 'auto out at 2 AM', tone: 'muted', pastOnly: true },
  { key: 'ot', today: 'In overtime', past: 'Did overtime', subToday: 'past the full day', subPast: 'past the full day', tone: 'warn' },
  { key: 'absent', today: 'Absent', past: 'Absent', subToday: 'no punch, no leave', subPast: 'no punch, no leave', tone: 'bad' },
  { key: 'late', today: 'Late in', past: 'Late in', subToday: 'after the grace time', subPast: 'after the grace time', tone: 'warn' },
  { key: 'early', today: 'Left early', past: 'Left early', subToday: 'under the full day', subPast: 'under the full day', tone: 'bad' },
  { key: 'leave', today: 'On leave', past: 'On leave', subToday: 'approved leave', subPast: 'approved leave', tone: 'muted' },
];

/** The views that apply to a day (live or closed), with their words resolved. */
export function viewsFor(isToday) {
  return VIEW_DEFS.filter((v) => (isToday ? !v.pastOnly : !v.todayOnly)).map((v) => ({
    key: v.key,
    label: isToday ? v.today : v.past,
    sub: isToday ? v.subToday : v.subPast,
    tone: v.tone,
    colour: v.tone ? TONE[v.tone] : 'var(--foreground)',
  }));
}

export const viewLabel = (key, isToday) => viewsFor(isToday).find((v) => v.key === key)?.label ?? 'Everyone';

/** Department colour tokens are stored as "chart-1" … "chart-5". */
export const deptColour = (token) => (token ? `var(--${token})` : 'var(--muted-foreground)');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const parts = (iso) => iso.split('-').map(Number);
export const weekday = (iso) => {
  const [y, m, d] = parts(iso);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
export const monthName = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
/** "Wednesday, 30 September 2026" */
export const fullDate = (iso) => {
  const [y, m, d] = parts(iso);
  return `${weekday(iso)}, ${d} ${MONTHS[m - 1]} ${y}`;
};
/** "Tue 29 Sep" */
export const shortDate = (iso) => {
  const [, m, d] = parts(iso);
  return `${weekday(iso).slice(0, 3)} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
};
/** What to call a day relative to today: "Today", "Yesterday", "Mon 28". */
export function dayName(iso, today, addDays) {
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  const [, , d] = parts(iso);
  return `${weekday(iso).slice(0, 3)} ${d}`;
}

/** Up to `n` faces with different initials, so a stack never looks like one person twice. */
export function faceStack(list, n = 2) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const ini = initialsOf(p.name);
    if (out.length < n && !seen.has(ini)) {
      seen.add(ini);
      out.push({ id: p.id, ini, name: p.name });
    }
  }
  return { faces: out, more: Math.max(0, list.length - out.length) };
}

export const initialsOf = (name) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
