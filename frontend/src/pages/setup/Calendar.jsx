import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { hhmm, longDate } from '@/utils';
import { PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog, Switch } from '@/components/ui/overlay';

const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export default function Calendar() {
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const shifts = useQuery({ queryKey: ['shifts'], queryFn: () => api.get('/shifts').then((r) => r.data) });
  const holidays = useQuery({ queryKey: ['holidays', year], queryFn: () => api.get('/holidays', { year }).then((r) => r.data) });
  const [addShift, setAddShift] = useState(false);
  const [addHoliday, setAddHoliday] = useState(false);
  const del = useMutation({
    mutationFn: (id) => api.del(`/holidays/${id}`),
    onSuccess: (r) => {
      if (r.warning) toast.warning(r.warning);
      else toast.success('Holiday removed');
      qc.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Shifts and holidays" description="Holidays apply company-wide. Changing a holiday inside a locked month warns and does not alter its payslips — they are snapshots." />
      <Card>
        <CardHeader
          title="Shifts"
          actions={
            <Button size="sm" onClick={() => setAddShift(true)}>
              <Plus /> New shift
            </Button>
          }
        />

        {shifts.isLoading ? (
          <SkeletonRows rows={3} />
        ) : shifts.isError ? (
          <ErrorState error={shifts.error} />
        ) : (
          <div className="overflow-x-auto"><table className="data-table w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Start</th>
                <th>End</th>
                <th>Break</th>
                <th>Pay groups using it</th>
              </tr>
            </thead>
            <tbody>
              {shifts.data.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.name}</td>
                  <td className="num">{hhmm(s.start_min)}</td>
                  <td className="num">
                    {hhmm(s.end_min)} {s.crosses_midnight && <Chip tone="info">next day</Chip>}
                  </td>
                  <td className="num">{s.break_min} min</td>
                  <td>{s.pay_groups.map((g) => g.name).join(', ') || <span className="text-muted-foreground">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Holidays"
          actions={
            <>
              <Select className="h-7 w-24" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
                {[year - 1, year, year + 1].map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </Select>
              <Button size="sm" onClick={() => setAddHoliday(true)}>
                <Plus /> Add holiday
              </Button>
            </>
          }
        />

        {holidays.isLoading ? (
          <SkeletonRows rows={6} />
        ) : holidays.isError ? (
          <ErrorState error={holidays.error} />
        ) : !holidays.data.length ? (
          <EmptyState title={`No holidays in ${year}`} body="Add the company's holidays for the year." />
        ) : (
          <div className="overflow-x-auto"><table className="data-table w-full">
            <thead>
              <tr>
                <th>Date</th>
                <th>Holiday</th>
                <th className="text-right">Worked by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {holidays.data.map((h) => (
                <tr key={h.id}>
                  <td className="num">{longDate(h.date)}</td>
                  <td>{h.name}</td>
                  <td className="text-right num">{h.worked_by ? `${h.worked_by} people` : '—'}</td>
                  <td className="text-right">
                    <Button size="icon" variant="ghost" onClick={() => del.mutate(h.id)} aria-label={`Remove ${h.name}`}>
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {addShift && <ShiftDialog onClose={() => setAddShift(false)} />}
      {addHoliday && <HolidayDialog onClose={() => setAddHoliday(false)} />}
    </div>
  );
}

function ShiftDialog({ onClose }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', start: '09:00', end: '17:30', break_min: '30', crosses: false });
  const save = useMutation({
    mutationFn: () => api.post('/shifts', { name: f.name, start_min: toMin(f.start), end_min: toMin(f.end), break_min: Number(f.break_min), crosses_midnight: f.crosses }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New shift"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.name} loading={save.isPending} onClick={() => save.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        </Field>
        <Field label="Start">{(id) => <Input id={id} type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />}</Field>
        <Field label="End">{(id) => <Input id={id} type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />}</Field>
        <Field label="Break (minutes)">{(id) => <Input id={id} type="number" value={f.break_min} onChange={(e) => setF({ ...f, break_min: e.target.value })} />}</Field>
        <label className="flex items-center gap-2 pt-5 text-[14px]">
          <Switch checked={f.crosses} onCheckedChange={(v) => setF({ ...f, crosses: v })} label="Crosses midnight" /> Crosses midnight
        </label>
      </div>
    </Dialog>
  );
}

function HolidayDialog({ onClose }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ date: '', name: '' });
  const save = useMutation({
    mutationFn: () => api.post('/holidays', f),
    onSuccess: (r) => {
      if (r.warning) toast.warning(r.warning);
      qc.invalidateQueries({ queryKey: ['holidays'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a holiday"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.date || !f.name} loading={save.isPending} onClick={() => save.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date">{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}
