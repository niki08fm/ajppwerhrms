import { mulDiv, type Paise } from '@ajpwer/shared';
import type { DayOverride, DayRecord } from './types';

export interface EmployeeIntervals {
  employee_id: string;
  /** Cost to company for the month */
  ctc_month: Paise;
  /** Paired intervals for the month: minutes and the site of the IN punch */
  intervals: { site_id: string; minutes: number }[];
}

export interface ProjectCostRow {
  project_id: string;
  minutes: number;
  cost: Paise;
  people: number;
}

/**
 * Project labour cost, split by minutes. Each paired interval is attributed to
 * the site of its IN punch; cost per minute for a person in a month is their
 * cost to company over their total worked minutes.
 *
 *   project cost = Σ minutes at that project's sites × ctc ÷ worked minutes
 *
 * Overtime and off-day premiums sit inside ctc and are therefore spread across
 * all of the person's minutes, not attributed to the site where they happened.
 */
export function projectLabourCost(employees: EmployeeIntervals[], siteProject: Record<string, string | null>): ProjectCostRow[] {
  const rows = new Map<string, { minutes: number; cost: Paise; people: Set<string> }>();
  for (const e of employees) {
    const total = e.intervals.reduce((s, i) => s + i.minutes, 0);
    if (total <= 0) continue;
    const byProject = new Map<string, number>();
    for (const i of e.intervals) {
      const p = siteProject[i.site_id];
      if (!p) continue;
      byProject.set(p, (byProject.get(p) ?? 0) + i.minutes);
    }
    for (const [p, minutes] of byProject) {
      const row = rows.get(p) ?? { minutes: 0, cost: 0, people: new Set<string>() };
      row.minutes += minutes;
      row.cost += mulDiv(e.ctc_month, minutes, total);
      row.people.add(e.employee_id);
      rows.set(p, row);
    }
  }
  return [...rows.entries()].map(([project_id, r]) => ({ project_id, minutes: r.minutes, cost: r.cost, people: r.people.size }));
}

/** Intervals of a classified day: one per closed pair, attributed to its IN site. */
export function dayIntervals(day: Pick<DayRecord, 'pairs'>): { site_id: string; minutes: number }[] {
  return day.pairs.filter((p) => p.out && p.minutes > 0).map((p) => ({ site_id: p.site_id, minutes: p.minutes }));
}

/** An override that changes nothing is noise in the audit trail. */
export function overrideDiffers(computed: DayOverride, proposed: DayOverride): boolean {
  return (
    computed.status !== proposed.status ||
    Math.abs(computed.day_value - proposed.day_value) > 1e-9 ||
    computed.worked_min !== proposed.worked_min ||
    computed.ot_min !== proposed.ot_min ||
    computed.late_min !== proposed.late_min
  );
}
