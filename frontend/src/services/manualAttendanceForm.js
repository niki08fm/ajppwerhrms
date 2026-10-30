const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const newManualEntry = (date) => ({ client_request_id: crypto.randomUUID(), work_date: date, reason: 'Device or network was unavailable', rows: [] });
export function timeMinutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '')) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function rowMinutes(row) {
  const inMin = timeMinutes(row.in_time), out = timeMinutes(row.out_time);
  return { in_min: inMin, out_min: out === null ? null : out + (row.out_next_day ? 1440 : 0) };
}
export function manualEntryError(entry, today, now = Date.now()) {
  if (!validDate(entry.work_date) || entry.work_date > today) return 'Choose today or an earlier attendance date.';
  if (entry.reason.trim().length < 3 || entry.reason.trim().length > 300) return 'Add a reason between 3 and 300 characters.';
  if (!entry.rows.length) return 'Add at least one employee.';
  if (entry.rows.length > 500) return 'A sheet can contain up to 500 employees.';
  const seen = new Set();
  for (const row of entry.rows) {
    if (seen.has(row.employee.code.toLowerCase())) return 'Each employee can appear only once in a sheet.';
    seen.add(row.employee.code.toLowerCase());
    const { in_min, out_min } = rowMinutes(row);
    if (in_min === null || out_min === null) return `Enter both punch times for ${row.employee.name}.`;
    if (out_min <= in_min || out_min - in_min > 1440) return `Check ${row.employee.name}'s times. Punch-out must follow punch-in and be within 24 hours.`;
    if (Date.parse(`${entry.work_date}T00:00:00+05:30`) + out_min * 60_000 > now) return `Punch-out for ${row.employee.name} has not happened yet. Enter the time after they leave.`;
  }
  return null;
}
export const manualEntryPayload = (entry) => ({ client_request_id: entry.client_request_id, work_date: entry.work_date, reason: entry.reason.trim(),
  rows: entry.rows.map((row) => ({ employee_code: row.employee.code, ...rowMinutes(row) })) });
