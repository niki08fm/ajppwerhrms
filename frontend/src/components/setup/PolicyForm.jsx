import { Plus, Trash2 } from 'lucide-react';
import { AJPWER_LEAVE_TYPES, formatINR, formatMinutes, OT_BASES, OT_BASE_LABELS } from '@ajpwer/shared';
import { Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';

export const DEFAULT_RULES = {
  ATTENDANCE: { standard_min: 480, half_day_min: 240, grace_min: 15 },
  OVERTIME: { multiplier: 2, base: 'BASIC_HRA', divisor: null, hours_per_day: 8, after_min: 30, rounding_min: 30, monthly_cap_min: 3000 },
  WEEKOFF_PAY: { paid: true, sandwich: false },
  HOLIDAY_PAY: { paid: true, sandwich: false },
  HOLIDAY_WORK: { holiday: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 }, weekly_off: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 } },
  LATE_PENALTY: {
    free_per_month: 3,
    slabs: [
      { from_min: 1, to_min: 30, deduct_days: 0.25 },
      { from_min: 31, to_min: 120, deduct_days: 0.5 },
      { from_min: 121, to_min: null, deduct_days: 1 },
    ],
  },
  LEAVE: { types: AJPWER_LEAVE_TYPES },
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
    case 'ATTENDANCE':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <HoursInput label="Standard day (minutes)" value={rules.standard_min} onChange={(v) => set({ standard_min: v })} />
          <HoursInput label="Half day from (minutes)" value={rules.half_day_min} onChange={(v) => set({ half_day_min: v })} />
          <Field label="Grace (minutes)">{(id) => <Input id={id} type="number" min={0} value={rules.grace_min} onChange={(e) => set({ grace_min: num(e.target.value) })} />}</Field>
        </div>
      );
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
        </div>
      );
    case 'WEEKOFF_PAY':
    case 'HOLIDAY_PAY':
      return (
        <div className="flex flex-col gap-3 text-[13px]">
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>
              <span className="font-medium">{kind === 'WEEKOFF_PAY' ? 'Weekly offs are paid' : 'Holidays are paid'}</span>
              <span className="block text-[12px] text-muted-foreground">Inside the monthly salary; not deducted.</span>
            </span>
            <Switch checked={rules.paid} onCheckedChange={(v) => set({ paid: v, sandwich: v ? rules.sandwich : false })} label="Paid" />
          </label>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>
              <span className="font-medium">Sandwich rule</span>
              <span className="block text-[12px] text-muted-foreground">
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
    case 'LATE_PENALTY':
      return (
        <div className="flex flex-col gap-3">
          <Field label="Free lates per month" className="max-w-xs">
            {(id) => <Input id={id} type="number" min={0} value={rules.free_per_month} onChange={(e) => set({ free_per_month: num(e.target.value) })} />}
          </Field>
          <table className="text-[13px]">
            <thead className="text-left text-[12px] text-muted-foreground">
              <tr>
                <th>From (min late)</th>
                <th>To (blank = and above)</th>
                <th>Days deducted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.slabs.map((s, i) => (
                <tr key={i}>
                  <td className="pr-2 py-1">
                    <Input
                      type="number"
                      min={1}
                      value={s.from_min}
                      onChange={(e) => set({ slabs: rules.slabs.map((x, j) => (j === i ? { ...x, from_min: num(e.target.value) } : x)) })}
                      aria-label="From minutes"
                    />
                  </td>
                  <td className="pr-2 py-1">
                    <Input
                      type="number"
                      min={1}
                      value={s.to_min ?? ''}
                      onChange={(e) => set({ slabs: rules.slabs.map((x, j) => (j === i ? { ...x, to_min: e.target.value ? num(e.target.value) : null } : x)) })}
                      aria-label="To minutes"
                    />
                  </td>
                  <td className="pr-2 py-1">
                    <Select value={s.deduct_days} onChange={(e) => set({ slabs: rules.slabs.map((x, j) => (j === i ? { ...x, deduct_days: num(e.target.value) } : x)) })} aria-label="Days deducted">
                      {[0, 0.25, 0.5, 0.75, 1].map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Button size="icon" variant="ghost" onClick={() => set({ slabs: rules.slabs.filter((_, j) => j !== i) })} aria-label="Remove slab">
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button size="sm" variant="outline" className="w-fit" onClick={() => set({ slabs: [...rules.slabs, { from_min: (rules.slabs.at(-1)?.to_min ?? 0) + 1, to_min: null, deduct_days: 1 }] })}>
            <Plus /> Add slab
          </Button>
        </div>
      );
    case 'LEAVE':
      return (
        <table className="text-[13px]">
          <thead className="text-left text-[12px] text-muted-foreground">
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Days a year</th>
              <th>Paid</th>
              <th>Encashable</th>
              <th>Accrues monthly</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.types.map((t, i) => {
              const upd = (p) => set({ types: rules.types.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <Input className="w-20 font-mono uppercase" value={t.code} onChange={(e) => upd({ code: e.target.value.toUpperCase() })} aria-label="Code" />
                  </td>
                  <td className="py-1 pr-2">
                    <Input value={t.name} onChange={(e) => upd({ name: e.target.value })} aria-label="Name" />
                  </td>
                  <td className="py-1 pr-2">
                    <Input className="w-20" type="number" min={0} value={t.annual_days} onChange={(e) => upd({ annual_days: num(e.target.value) })} aria-label="Days a year" />
                  </td>
                  <td>
                    <Switch checked={t.paid} onCheckedChange={(v) => upd({ paid: v })} label="Paid" />
                  </td>
                  <td>
                    <Switch checked={t.encashable} onCheckedChange={(v) => upd({ encashable: v })} label="Encashable" />
                  </td>
                  <td>
                    <Switch checked={t.accrues} onCheckedChange={(v) => upd({ accrues: v })} label="Accrues" />
                  </td>
                  <td>
                    <Button size="icon" variant="ghost" onClick={() => set({ types: rules.types.filter((_, j) => j !== i) })} aria-label="Remove type">
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={7} className="pt-2">
                <Button size="sm" variant="outline" onClick={() => set({ types: [...rules.types, { code: 'NEW', name: '', annual_days: 0, paid: true, encashable: false, accrues: false }] })}>
                  <Plus /> Add leave type
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      );
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
        {rules.after_min > 0 && ` Extra time under ${rules.after_min} minutes earns nothing; above it, time is rounded down to ${rules.rounding_min}-minute steps.`}
        {rules.monthly_cap_min ? ` Anything above ${formatMinutes(rules.monthly_cap_min)} a month is unpaid and reported on the payslip.` : ''}
      </>
    );
  } else if (kind === 'ATTENDANCE') {
    body = (
      <>
        A day of {formatMinutes(Math.ceil(rules.standard_min * 0.92))} or more is present (92% of {formatMinutes(rules.standard_min)}); {formatMinutes(rules.half_day_min)} or more is a half day; less
        is short and unpaid. Someone arriving {rules.grace_min + 5} minutes after shift start is 5 minutes late.
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
  } else if (kind === 'LATE_PENALTY') {
    const first = rules.slabs[0];
    body = first ? (
      <>
        The first {rules.free_per_month} lates in a month cost nothing. The next one of {first.from_min + 10} minutes deducts {first.deduct_days} day — {formatINR(Math.round(day * first.deduct_days))}{' '}
        on {formatINR(s.gross)} ÷ {s.divisor}. Lateness is charged monthly, never per day.
      </>
    ) : null;
  } else if (kind === 'LEAVE') {
    const paid = rules.types.filter((t) => t.paid).reduce((a, t) => a + t.annual_days, 0);
    const enc = rules.types.find((t) => t.encashable);
    body = (
      <>
        {paid} paid days a year across all types.{enc ? ` Each unused day of ${enc.name.toLowerCase()} is worth ${formatINR(Math.round(s.gross / 26))} at exit (${formatINR(s.gross)} ÷ 26).` : ''}
      </>
    );
  }
  return body ? (
    <Notice tone="info">
      <span className="font-medium">Worked example. </span>
      {body}
    </Notice>
  ) : null;
}
