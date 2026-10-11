import { useState } from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { useSession } from '@/context/SessionContext';
import { download, errorMessage, qs } from '@/services/api';
import { Button } from '@/components/ui/button';
import { ChoiceCards, Segmented } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { fullDate, monthName } from './dayVocab';

/** Reports include every matching employee, independent of the register's current page. */
export function AttendanceReportDownload({ period, monthly = false, filters = {}, total, disabled = false }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState('summary');
  const [format, setFormat] = useState('xlsx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!can('attendance.read') || !can('reports.export')) return null;

  const exportReport = async () => {
    setBusy(true);
    setError('');
    // Paging controls never restrict a report. The server applies the same search and filters.
    const params = { ...filters, page: undefined, limit: undefined, 'filter[page]': undefined, 'filter[limit]': undefined, format };
    if (monthly) Object.assign(params, { ym: period, report });
    else Object.assign(params, { date: period });
    try {
      await download(`/attendance/reports/${monthly ? 'monthly' : 'daily'}${qs(params)}`, `attendance-${period}${monthly ? `-${report}` : ''}.${format}`);
      setOpen(false);
      toast.success('Attendance report downloaded');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => { setError(''); setOpen(true); }}>
        <Download /> Download report
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => { if (!busy) setOpen(value); }}
        title={`Download ${monthly ? 'monthly' : 'daily'} report`}
        description={`${monthly ? monthName(period) : fullDate(period)}${total !== undefined ? ` · ${total.toLocaleString('en-IN')} employees` : ''}. Includes every matching employee across all pages.`}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={busy} onClick={exportReport}>
              {format === 'xlsx' ? <FileSpreadsheet /> : <FileText />} Download {format === 'xlsx' ? 'Excel' : 'PDF'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {monthly && (
            <ChoiceCards
              name="attendance-report"
              value={report}
              onChange={setReport}
              options={[
                { value: 'summary', label: 'Monthly summary', description: 'Working, present and absent days, paid leave, final LOP, overtime and late minutes for each employee.', disabled: busy },
                { value: 'detailed', label: 'Daily details for all employees', description: 'Every day of the month, with punch-in, punch-out, status and overtime. Missing punches are highlighted.', disabled: busy },
              ]}
            />
          )}
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium">Format</p>
            <Segmented label="Report format" value={format} onChange={setFormat} options={[{ value: 'xlsx', label: 'Excel', disabled: busy }, { value: 'pdf', label: 'PDF', disabled: busy }]} />
          </div>
          <p className="text-[13px] text-muted-foreground">{monthly ? 'Month totals include final loss of pay after applied and automatic leave. Late minutes are the total shortfall from the required shift.' : 'Includes each employee’s punch-in, punch-out, attendance status, overtime and late minutes. Missing punches are highlighted.'}</p>
          {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
        </div>
      </Dialog>
    </>
  );
}
