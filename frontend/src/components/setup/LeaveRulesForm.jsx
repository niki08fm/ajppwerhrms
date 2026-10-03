import { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import {
  formatINR,
  LEAVE_ALLOWANCE_LABELS,
  LEAVE_ALLOWANCES,
  LEAVE_GENDER_LABELS,
  LEAVE_GENDERS,
  LEAVE_ON_EXIT,
  LEAVE_ON_EXIT_LABELS,
  LEAVE_TEMPLATES,
  LEAVE_TYPE_DEFAULTS,
  LEAVE_YEAR_END,
  LEAVE_YEAR_END_LABELS,
  MONTH_NAMES,
  OT_BASES,
  OT_BASE_LABELS,
  upgradeLeaveRules,
} from '@ajpwer/shared';
import { Chip } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';

const hasBalance = (t) => t.allowance === 'MONTHLY' || t.allowance === 'YEARLY';
const pays = (t) => t.year_end === 'ENCASH' || (t.year_end === 'CARRY_FORWARD' && t.carry_excess === 'ENCASH') || t.on_exit === 'ENCASH';
const numOrNull = (v) => (v === '' ? null : Number(v));

/** One line about a type, for its collapsed row. */
export function leaveTypeSummary(t) {
  if (!t.paid) return 'Unpaid';
  const parts = [];
  if (t.allowance === 'MONTHLY') parts.push(`${t.per_month} a month${t.yearly_cap !== null ? `, up to ${t.yearly_cap} a year` : ''}`);
  if (t.allowance === 'YEARLY') parts.push(`${t.per_year} a year`);
  if (t.allowance === 'PER_OCCASION') parts.push(`${t.per_occasion} working days each time`);
  if (t.allowance === 'NONE') parts.push('no balance');
  if (t.monthly_max !== null && t.allowance !== 'PER_OCCASION') parts.push(`at most ${t.monthly_max} a month`);
  if (hasBalance(t)) {
    if (t.year_end === 'CARRY_FORWARD') parts.push(`carry forward${t.carry_max !== null ? ` ${t.carry_max}` : ''}${t.carry_max !== null && t.carry_excess === 'ENCASH' ? ', rest paid out' : ''}`);
    else parts.push(t.year_end === 'ENCASH' ? 'paid out at year end' : 'lapses at year end');
    if (t.on_exit === 'ENCASH') parts.push('paid on exit');
  }
  if (t.gender !== 'ALL') parts.push(LEAVE_GENDER_LABELS[t.gender].toLowerCase());
  if (t.min_service_months) parts.push(`after ${t.min_service_months} months`);
  return parts.join(' · ');
}

function NumberField({ label, hint, value, onChange, step = '0.25', min = 0, blank }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type="number" step={step} min={min} value={value ?? ''} placeholder={blank} onChange={(e) => onChange(blank !== undefined ? numOrNull(e.target.value) : Number(e.target.value || 0))} />}
    </Field>
  );
}

function Choice({ label, hint, value, options, labels, onChange }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o} value={o}>
              {labels[o]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function TypeDetails({ t, onChange }) {
  return (
    <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-3">
      <Field label="Code" hint="Capital letters, as it shows on the calendar">
        {(id) => <Input id={id} className="font-mono uppercase" value={t.code} maxLength={10} onChange={(e) => onChange({ code: e.target.value.toUpperCase().replace(/[^A-Z_]/g, '') })} />}
      </Field>
      <Field label="Name" className="sm:col-span-2">
        {(id) => <Input id={id} value={t.name} onChange={(e) => onChange({ name: e.target.value })} />}
      </Field>
      <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-[14px] sm:col-span-3">
        <span>
          <span className="font-medium">Paid</span>
          <span className="block text-[13px] text-muted-foreground">Unpaid leave is recorded for the register and paid as loss of pay.</span>
        </span>
        <Switch checked={t.paid} onCheckedChange={(v) => onChange(v ? { paid: true } : { paid: false, allowance: 'NONE', auto_apply: false })} label="Paid" />
      </label>
      {t.paid && (
        <>
          <Choice label="Days come" value={t.allowance} options={LEAVE_ALLOWANCES} labels={LEAVE_ALLOWANCE_LABELS} onChange={(v) => onChange({ allowance: v, auto_apply: t.auto_apply && (v === 'MONTHLY' || v === 'YEARLY') })} />
          {t.allowance === 'MONTHLY' && (
            <>
              <NumberField label="Earned each month" hint="Part of it in a part month" value={t.per_month} onChange={(v) => onChange({ per_month: v })} />
              <NumberField label="Yearly cap" hint="Most earned in a leave year; blank for none" value={t.yearly_cap} blank="No cap" onChange={(v) => onChange({ yearly_cap: v })} />
            </>
          )}
          {t.allowance === 'YEARLY' && (
            <NumberField label="Days a year" hint="Given when the leave year starts; part of them for a joiner" value={t.per_year} onChange={(v) => onChange({ per_year: v })} />
          )}
          {t.allowance === 'PER_OCCASION' && (
            <NumberField label="Working days each time" hint="Weekly offs and holidays in between are not counted" step="1" value={t.per_occasion} onChange={(v) => onChange({ per_occasion: v })} />
          )}
          {t.allowance !== 'PER_OCCASION' && (
            <NumberField label="Most paid in a month" hint="Blank for no limit" value={t.monthly_max} blank="No limit" onChange={(v) => onChange({ monthly_max: v })} />
          )}
          <NumberField label="Usable after (months of service)" step="1" value={t.min_service_months} onChange={(v) => onChange({ min_service_months: Math.round(v) })} />
          <Choice label="For" value={t.gender} options={LEAVE_GENDERS} labels={LEAVE_GENDER_LABELS} onChange={(v) => onChange({ gender: v })} />
        </>
      )}
      {t.paid && hasBalance(t) && (
        <>
          <Choice label="Left at the end of the leave year" value={t.year_end} options={LEAVE_YEAR_END} labels={LEAVE_YEAR_END_LABELS} onChange={(v) => onChange({ year_end: v })} />
          {t.year_end === 'CARRY_FORWARD' && (
            <>
              <NumberField label="Carry forward at most" hint="Blank carries all of it" value={t.carry_max} blank="All" onChange={(v) => onChange({ carry_max: v })} />
              <Choice label="Days above that" value={t.carry_excess} options={['LAPSE', 'ENCASH']} labels={{ LAPSE: 'Lapse', ENCASH: 'Paid out' }} onChange={(v) => onChange({ carry_excess: v })} />
            </>
          )}
          <Choice label="Left when someone leaves" value={t.on_exit} options={LEAVE_ON_EXIT} labels={LEAVE_ON_EXIT_LABELS} onChange={(v) => onChange({ on_exit: v })} />
          {pays(t) && (
            <>
              <Choice label="A day paid out is" value={t.encash_base} options={OT_BASES} labels={OT_BASE_LABELS} onChange={(v) => onChange({ encash_base: v })} />
              <NumberField label="Divided by (days)" step="1" min={1} value={t.encash_divisor} onChange={(v) => onChange({ encash_divisor: Math.max(1, Math.round(v)) })} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The leave policy: when the leave year starts, which type pays absences nobody applied
 * for, and every type with its own rules. HR records all the other kinds.
 */
export function LeaveRulesForm({ rules, onChange }) {
  const r = upgradeLeaveRules(rules);
  const [open, setOpen] = useState(null);
  const set = (patch) => onChange({ ...r, ...patch });
  const setType = (i, patch) => set({ types: r.types.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const auto = r.types.find((t) => t.auto_apply);
  const autoCandidates = r.types.filter((t) => t.paid && hasBalance(t));
  const end = ((r.year_start_month + 10) % 12) + 1;
  const add = (code) => {
    const tpl = code === 'BLANK' ? { ...LEAVE_TYPE_DEFAULTS, code: 'NEW', name: '', per_year: 0 } : LEAVE_TEMPLATES.find((t) => t.code === code);
    // Codes are letters only: a second copy of SL becomes SL_B.
    let c = tpl.code;
    for (let n = 2; r.types.some((t) => t.code === c); n++) c = `${tpl.code}_${String.fromCharCode(64 + n)}`;
    set({ types: [...r.types, { ...tpl, code: c, auto_apply: tpl.auto_apply && !auto }] });
    setOpen(r.types.length);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Leave year" hint={`${MONTH_NAMES[r.year_start_month - 1]} to ${MONTH_NAMES[end - 1]}: the yearly cap resets, and what is left lapses, carries forward or is paid out`}>
          {(id) => (
            <Select id={id} value={r.year_start_month} onChange={(e) => set({ year_start_month: Number(e.target.value) })}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i + 1}>
                  Starts in {m}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Absences nobody applied for are paid from" hint="Half days too, up to the balance and the monthly limit. HR records every other kind on the person's behalf.">
          {(id) => (
            <Select id={id} value={auto?.code ?? ''} onChange={(e) => set({ types: r.types.map((t) => ({ ...t, auto_apply: t.code === e.target.value })) })}>
              <option value="">Nothing: they are loss of pay</option>
              {autoCandidates.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name} ({t.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <ul className="flex flex-col gap-2">
        {r.types.map((t, i) => (
          <li key={i} className="rounded-md border">
            <div className="flex items-center gap-2 px-3 py-2 text-[14px]">
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                {open === i ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                <Chip tone={t.auto_apply ? 'info' : 'default'}>{t.code || '—'}</Chip>
                <span className="font-medium">{t.name || 'Unnamed'}</span>
                <span className="truncate text-[13px] text-muted-foreground">{t.auto_apply ? 'Pays absences automatically · ' : ''}{leaveTypeSummary(t)}</span>
              </button>
              <Switch checked={t.active} onCheckedChange={(v) => setType(i, { active: v })} label={`${t.name} active`} />
              <Button size="icon" variant="ghost" onClick={() => set({ types: r.types.filter((_, j) => j !== i) })} aria-label={`Remove ${t.name}`}>
                <Trash2 />
              </Button>
            </div>
            {open === i && <TypeDetails t={t} onChange={(p) => setType(i, p)} />}
          </li>
        ))}
      </ul>
      <Field label="Add a leave type" className="max-w-xs">
        {(id) => (
          <Select id={id} value="" onChange={(e) => add(e.target.value)}>
            <option value="" disabled>
              Choose a starting point…
            </option>
            {LEAVE_TEMPLATES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
            <option value="BLANK">Blank</option>
          </Select>
        )}
      </Field>
    </div>
  );
}

/** The worked example for a leave policy, in rupees. */
export function LeaveExample({ rules, s }) {
  const r = upgradeLeaveRules(rules);
  const a = r.types.find((t) => t.auto_apply && t.active);
  const day = (t) => Math.round((t.encash_base === 'BASIC' ? s.basic : t.encash_base === 'BASIC_HRA' ? s.basic + s.hra : s.gross) / t.encash_divisor);
  const lop = Math.round(s.gross / s.divisor);
  const end = MONTH_NAMES[((r.year_start_month + 10) % 12)];
  const others = r.types.filter((t) => t.active && !t.auto_apply).map((t) => t.name.toLowerCase());
  if (!a) return <>No type pays absences automatically: an absence nobody applied for costs {formatINR(lop)} on {formatINR(s.gross)} ÷ {s.divisor}.</>;
  return (
    <>
      {a.name}: {leaveTypeSummary(a)}. An absence nobody applied for takes a day of it, and a half day half a day; with none left, it is loss of pay ({formatINR(lop)} on{' '}
      {formatINR(s.gross)} ÷ {s.divisor}).
      {a.year_end === 'ENCASH' && ` What is left at the end of ${end} is paid out at ${formatINR(day(a))} a day.`}
      {a.year_end === 'CARRY_FORWARD' &&
        ` At the end of ${end}, ${a.carry_max === null ? 'all of it carries' : `up to ${a.carry_max} days carry`} forward${a.carry_max !== null ? (a.carry_excess === 'ENCASH' ? ` and the rest is paid out at ${formatINR(day(a))} a day` : ' and the rest lapses') : ''}.`}
      {a.year_end === 'LAPSE' && ` What is left at the end of ${end} lapses.`}
      {a.on_exit === 'ENCASH' ? ` On exit, what is left is paid in the settlement at ${formatINR(day(a))} a day.` : ' On exit, what is left lapses.'}
      {others.length > 0 && ` HR records ${others.join(', ')} on the person's behalf.`}
    </>
  );
}
