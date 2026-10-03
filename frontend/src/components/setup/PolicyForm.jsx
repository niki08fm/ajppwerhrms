import {
  AJPWER_LEAVE_RULES,
  formatINR,
  formatMinutes,
  GRATUITY_PART_YEAR_LABELS,
  GRATUITY_PART_YEARS,
  OT_BASES,
  OT_BASE_LABELS,
  OT_COUNTS_FROM,
  OT_COUNTS_FROM_LABELS,
  STATUTORY_GRATUITY_RULES,
} from '@ajpwer/shared';
import { toPaise, toRupeesInput } from '@/utils';
import { Notice } from '@/components/states';
import { Field, Input, Select } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';
import { LeaveExample, LeaveRulesForm } from './LeaveRulesForm';

export const DEFAULT_RULES = {
  ATTENDANCE: { standard_min: 540, half_day_min: 0, half_day_upto_min: 240, grace_min: 15 },
  OVERTIME: { multiplier: 2, base: 'BASIC_HRA', divisor: null, hours_per_day: 8, after_min: 30, rounding_min: 30, monthly_cap_min: 3000, counts_from: 'SHIFT_END' },
  WEEKOFF_PAY: { paid: true, sandwich: false },
  HOLIDAY_PAY: { paid: true, sandwich: false },
  HOLIDAY_WORK: { holiday: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 }, weekly_off: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 } },
  LEAVE: AJPWER_LEAVE_RULES,
  GRATUITY: STATUTORY_GRATUITY_RULES,
};

const rateText = (pct) => `${pct}% — normal day plus ${pct - 100 === 100 ? 'one extra day' : pct - 100 === 200 ? 'two extra days' : `${(pct - 100) / 100} extra days`}`;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function HoursInput({ value, onChange, label }) {
  return (
    <Field label={label} hint={formatMinutes(value)}>
      {(id) => <Input id={id} type="number" min={0} value={value} onChange={(e) => onChange(num(e.target.value))} />}
    </Field>
  );
}

/** A form shaped for each kind. */
export function PolicyForm({ kind, rules, onChange }) {
  const set = (patch) => onChange({ ...rules, ...patch });
  switch (kind) {
    case 'ATTENDANCE': {
      const upto = rules.half_day_upto_min ?? null;
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <HoursInput label="Standard day (minutes)" value={rules.standard_min} onChange={(v) => set({ standard_min: v })} />
          <Field label="Grace (minutes)" hint="Coming in this late is still on time">
            {(id) => <Input id={id} type="number" min={0} value={rules.grace_min} onChange={(e) => set({ grace_min: num(e.target.value) })} />}
          </Field>
          <Field label="Half day up to (minutes)" hint={upto === null ? 'Blank: a full day needs 92% of the standard day' : `${formatMinutes(upto)}; more is a full day`}>
            {(id) => <Input id={id} type="number" min={0} value={upto ?? ''} onChange={(e) => set({ half_day_upto_min: e.target.value === '' ? null : num(e.target.value) })} />}
          </Field>
          <Field label="Half day from (minutes)" hint={rules.half_day_min ? `${formatMinutes(rules.half_day_min)}; less is short and unpaid` : 'Any time worked counts at least half'}>
            {(id) => <Input id={id} type="number" min={0} value={rules.half_day_min} onChange={(e) => set({ half_day_min: num(e.target.value) })} />}
          </Field>
        </div>
      );
    }
    case 'OVERTIME':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Multiplier">{(id) => <Input id={id} type="number" step="0.25" min={1} value={rules.multiplier} onChange={(e) => set({ multiplier: num(e.target.value) })} />}</Field>
          <Field label="Worked out on">
            {(id) => (
              <Select id={id} value={rules.base} onChange={(e) => set({ base: e.target.value })}>
                {OT_BASES.map((b) => (
                  <option key={b} value={b}>
                    {OT_BASE_LABELS[b]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Days divisor" hint="Blank uses the pay group's calendar">
            {(id) => <Input id={id} type="number" min={1} max={31} value={rules.divisor ?? ''} onChange={(e) => set({ divisor: e.target.value ? num(e.target.value) : null })} />}
          </Field>
          <Field label="Hours per day">{(id) => <Input id={id} type="number" step="0.5" min={1} value={rules.hours_per_day} onChange={(e) => set({ hours_per_day: num(e.target.value) })} />}</Field>
          <Field label="Counts after (minutes)" hint="Below this extra time, no overtime">
            {(id) => <Input id={id} type="number" min={0} value={rules.after_min} onChange={(e) => set({ after_min: num(e.target.value) })} />}
          </Field>
          <Field label="Round down to (minutes)">{(id) => <Input id={id} type="number" min={1} value={rules.rounding_min} onChange={(e) => set({ rounding_min: num(e.target.value) })} />}</Field>
          <Field label="Monthly cap (minutes)" hint={rules.monthly_cap_min ? formatMinutes(rules.monthly_cap_min) : 'No cap'}>
            {(id) => <Input id={id} type="number" min={0} value={rules.monthly_cap_min ?? ''} onChange={(e) => set({ monthly_cap_min: e.target.value ? num(e.target.value) : null })} />}
          </Field>
          <Field label="Counts from" className="sm:col-span-3">
            {(id) => (
              <Select id={id} value={rules.counts_from ?? 'STANDARD_DAY'} onChange={(e) => set({ counts_from: e.target.value })}>
                {OT_COUNTS_FROM.map((c) => (
                  <option key={c} value={c}>
                    {OT_COUNTS_FROM_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      );
    case 'WEEKOFF_PAY':
    case 'HOLIDAY_PAY':
      return (
        <div className="flex flex-col gap-3 text-[14px]">
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>
              <span className="font-medium">{kind === 'WEEKOFF_PAY' ? 'Weekly offs are paid' : 'Holidays are paid'}</span>
              <span className="block text-[13px] text-muted-foreground">Inside the monthly salary; not deducted.</span>
            </span>
            <Switch checked={rules.paid} onCheckedChange={(v) => set({ paid: v, sandwich: v ? rules.sandwich : false })} label="Paid" />
          </label>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>
              <span className="font-medium">Sandwich rule</span>
              <span className="block text-[13px] text-muted-foreground">
                If the nearest working days on both sides are absent or short, this off day is unpaid too. Approved leave does not trigger it.
              </span>
            </span>
            <Switch checked={rules.sandwich} disabled={!rules.paid} onCheckedChange={(v) => set({ sandwich: v })} label="Sandwich rule" />
          </label>
        </div>
      );
    case 'HOLIDAY_WORK':
      return (
        <div className="grid gap-4 md:grid-cols-2">
          {['holiday', 'weekly_off'].map((k) => (
            <div key={k} className="flex flex-col gap-3 rounded-md border p-3">
              <div className="font-medium">{k === 'holiday' ? 'Working a holiday' : 'Working a weekly off'}</div>
              <Field label="Pays">
                {(id) => (
                  <Select
                    id={id}
                    value={rules[k].mode === 'NONE' ? 'NONE' : String(rules[k].rate_pct)}
                    onChange={(e) => set({ [k]: e.target.value === 'NONE' ? { ...rules[k], mode: 'NONE' } : { ...rules[k], mode: 'PAY', rate_pct: Number(e.target.value) } })}
                  >
                    <option value="NONE">Nothing extra</option>
                    {[150, 200, 250, 300].map((p) => (
                      <option key={p} value={p}>
                        {rateText(p)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Worked out on">
                {(id) => (
                  <Select id={id} value={rules[k].base} onChange={(e) => set({ [k]: { ...rules[k], base: e.target.value } })}>
                    {OT_BASES.map((b) => (
                      <option key={b} value={b}>
                        {OT_BASE_LABELS[b]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Minimum to qualify (minutes)" hint={formatMinutes(rules[k].min_minutes)}>
                {(id) => <Input id={id} type="number" min={0} value={rules[k].min_minutes} onChange={(e) => set({ [k]: { ...rules[k], min_minutes: num(e.target.value) } })} />}
              </Field>
            </div>
          ))}
        </div>
      );
    case 'GRATUITY':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Qualifies after (years)">
            {(id) => <Input id={id} type="number" step="0.5" min={0} value={rules.min_years} onChange={(e) => set({ min_years: num(e.target.value) })} />}
          </Field>
          <Field label="Warn from (years)" hint="Leavers between this and qualifying get a warning">
            {(id) => <Input id={id} type="number" step="0.5" min={0} value={rules.flag_from_years} onChange={(e) => set({ flag_from_years: num(e.target.value) })} />}
          </Field>
          <Field label="Days' wages a year">
            {(id) => <Input id={id} type="number" min={0} value={rules.days_per_year} onChange={(e) => set({ days_per_year: num(e.target.value) })} />}
          </Field>
          <Field label="Days in a month" hint="A month's wages ÷ this is a day's">
            {(id) => <Input id={id} type="number" min={1} max={31} value={rules.divisor} onChange={(e) => set({ divisor: num(e.target.value) })} />}
          </Field>
          <Field label="Worked out on" hint="The last month's wages">
            {(id) => (
              <Select id={id} value={rules.base} onChange={(e) => set({ base: e.target.value })}>
                {OT_BASES.map((b) => (
                  <option key={b} value={b}>
                    {OT_BASE_LABELS[b]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Part of a year">
            {(id) => (
              <Select id={id} value={rules.part_year} onChange={(e) => set({ part_year: e.target.value })}>
                {GRATUITY_PART_YEARS.map((p) => (
                  <option key={p} value={p}>
                    {GRATUITY_PART_YEAR_LABELS[p]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Ceiling (₹)" hint={rules.max_amount === null ? 'No ceiling' : formatINR(rules.max_amount)}>
            {(id) => <Input id={id} type="number" min={0} value={toRupeesInput(rules.max_amount)} onChange={(e) => set({ max_amount: e.target.value === '' ? null : toPaise(e.target.value) })} />}
          </Field>
        </div>
      );
    case 'LEAVE':
      return <LeaveRulesForm rules={rules} onChange={onChange} />;
  }
}

const r2 = (p) => formatINR(Math.round(p), { paise: true });

/** Every policy form shows a worked example in rupees before saving. Policy settings are abstract; rupees are not. */
export function WorkedExample({ kind, rules, s }) {
  let body = null;
  const day = s.gross / s.divisor;
  if (kind === 'OVERTIME') {
    const base = rules.base === 'BASIC' ? s.basic : rules.base === 'BASIC_HRA' ? s.basic + s.hra : s.gross;
    const div = rules.divisor ?? s.divisor;
    const hourly = base / (div * rules.hours_per_day);
    const ten = hourly * 10 * rules.multiplier;
    body = (
      <>
        On a {formatINR(s.gross)} worker, {OT_BASE_LABELS[rules.base].toLowerCase()} is {formatINR(base)}, so an hour is {formatINR(base)} ÷ ({div} × {rules.hours_per_day}) ={' '}
        <strong>{r2(hourly)}</strong>; ten hours of overtime at {rules.multiplier}× pays <strong>{formatINR(Math.round(ten))}</strong>.
        {rules.counts_from === 'SHIFT_END'
          ? ' It counts from the end of the shift, or for a late arrival from a full standard day after they came in, and only for time beyond a full day.'
          : ' It is time worked beyond the standard day.'}
        {rules.after_min > 0 && ` Extra time under ${rules.after_min} minutes earns nothing; above it, time is rounded down to ${rules.rounding_min}-minute steps.`}
        {rules.monthly_cap_min ? ` Anything above ${formatMinutes(rules.monthly_cap_min)} a month is unpaid and reported on the payslip.` : ''}
      </>
    );
  } else if (kind === 'ATTENDANCE') {
    const upto = rules.half_day_upto_min ?? null;
    const late = rules.grace_min + 5;
    body = (
      <>
        {upto === null ? (
          <>
            A day of {formatMinutes(Math.ceil(rules.standard_min * 0.92))} or more is present (92% of {formatMinutes(rules.standard_min)}); {formatMinutes(rules.half_day_min)} or more is a half
            day; less is short and unpaid.
          </>
        ) : (
          <>
            More than {formatMinutes(upto)} worked is a full day; up to {formatMinutes(upto)} is a half day
            {rules.half_day_min > 0 ? `, and under ${formatMinutes(rules.half_day_min)} is short and unpaid` : ''}.
          </>
        )}{' '}
        Coming in up to {rules.grace_min} minutes after shift start is on time, and the day ends at shift end. Someone in {late} minutes after shift start is {late} minutes late, and their day
        ends {formatMinutes(rules.standard_min)} after they came in. Late logins and early punch-outs are flagged for HR; neither is deducted.
      </>
    );
  } else if (kind === 'WEEKOFF_PAY' || kind === 'HOLIDAY_PAY') {
    const what = kind === 'WEEKOFF_PAY' ? 'Sunday' : 'holiday';
    body = !rules.paid ? (
      <>
        Every {what} is unpaid: {formatINR(Math.round(day))} less for each one in the month on {formatINR(s.gross)} ÷ {s.divisor}.
      </>
    ) : rules.sandwich ? (
      <>
        Absent Saturday and Monday with a {what} between means <strong>three days'</strong> loss of pay, not two — {formatINR(Math.round(day * 3))} rather than {formatINR(Math.round(day * 2))} on{' '}
        {formatINR(s.gross)}.
      </>
    ) : (
      <>
        Absent Saturday and Monday with a {what} between costs two days — {formatINR(Math.round(day * 2))} on {formatINR(s.gross)}. The {what} stays paid.
      </>
    );
  } else if (kind === 'HOLIDAY_WORK') {
    const w = rules.weekly_off;
    const base = w.base === 'BASIC' ? s.basic : w.base === 'BASIC_HRA' ? s.basic + s.hra : s.gross;
    const extra = ((base / s.divisor) * (w.rate_pct - 100)) / 100;
    body =
      w.mode === 'NONE' ? (
        <>Working a weekly off earns nothing extra.</>
      ) : (
        <>
          Working a paid Sunday at {rateText(w.rate_pct)} adds <strong>{formatINR(Math.round(extra))}</strong> on {formatINR(s.gross)} — the day's own pay is already inside the salary, so the line
          pays the difference. Hours worked on an off day never count as overtime too.
        </>
      );
  } else if (kind === 'GRATUITY') {
    // 7 years 8 months of service.
    const years = rules.part_year === 'PRO_RATA' ? 7.67 : rules.part_year === 'OVER_SIX_MONTHS' ? 8 : 7;
    const wages = rules.base === 'BASIC' ? s.basic : rules.base === 'BASIC_HRA' ? s.basic + s.hra : s.gross;
    const full = Math.round((wages * rules.days_per_year * years) / rules.divisor);
    const capped = rules.max_amount !== null && full > rules.max_amount;
    body = (
      <>
        Leaving after 7 years 8 months on {formatINR(wages)} {OT_BASE_LABELS[rules.base].toLowerCase()}: {formatINR(wages)} × {rules.days_per_year} × {years} ÷ {rules.divisor} ={' '}
        <strong>{formatINR(capped ? rules.max_amount : full)}</strong>
        {capped ? `, the ceiling` : ''}. Under {rules.min_years} years nothing is paid
        {rules.flag_from_years < rules.min_years ? `; from ${rules.flag_from_years} years the settlement carries a warning to check` : ''}.
      </>
    );
  } else if (kind === 'LEAVE') {
    body = <LeaveExample rules={rules} s={s} />;
  }
  return body ? (
    <Notice tone="info">
      <span className="font-medium">Worked example. </span>
      {body}
    </Notice>
  ) : null;
}
