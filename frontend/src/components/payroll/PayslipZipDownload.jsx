import { useState } from 'react';
import { FolderArchive } from 'lucide-react';
import { toast } from 'sonner';
import { useSession } from '@/context/SessionContext';
import { download, errorMessage, qs } from '@/services/api';
import { Button } from '@/components/ui/button';

/** Download saved PDF payslips for one employee's year or one payroll month. */
export function PayslipZipDownload({ employeeId, employeeCode, year, ym, company, q, disabled = false, label = 'Download ZIP', className, size = 'sm', variant = 'outline' }) {
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  if (!can('payroll.read') || !can('reports.export')) return null;

  const employee = !!employeeId;
  const period = employee ? year : ym;
  const path = employee
    ? `/employees/${encodeURIComponent(employeeId)}/payslips.zip${qs({ year })}`
    : `/payroll/periods/${ym}/payslips.zip${qs({ company, q })}`;
  const code = String(employeeCode ?? 'employee').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = employee ? `payslips-${code}-${year}.zip` : `payslips-${ym}${company ? `-${company.toLowerCase()}` : ''}.zip`;
  const save = async () => {
    if (busy || disabled || !period) return;
    setBusy(true);
    try {
      await download(path, filename);
      toast.success('PDF payslips downloaded in a ZIP folder');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return <Button variant={variant} size={size} className={className} loading={busy} disabled={disabled || !period} onClick={save} title={`Download PDF payslips for ${period} in a ZIP folder`}>
    {!busy && <FolderArchive aria-hidden />}{label}
  </Button>;
}
