import { deptColour, initialsOf } from './dayVocab';

/** Department colours light enough to need dark initials. */
const LIGHT_TOKENS = ['chart-3', 'chart-4'];

/** A person's initials on their department's colour — the same circle on Attendance and Approvals. */
export function DeptAvatar({ name, token, size = 30 }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37), background: deptColour(token), color: LIGHT_TOKENS.includes(token) ? 'oklch(0.2 0.03 240)' : 'white' }}
    >
      {name ? initialsOf(name) : '?'}
    </span>
  );
}
