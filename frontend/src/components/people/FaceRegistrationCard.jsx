import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { longDate } from '@/utils';
import { KV } from '@/components/bits';
import { Chip, Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

const dateTime = (value) => value ? new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(value)) : '—';

/** HR permits one replacement; the employee captures the face at a site tablet. */
export function FaceRegistrationCard({ e }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [reason, setReason] = useState('');
  const status = useQuery({
    queryKey: ['employee-face-registration', e.id],
    queryFn: () => api.get(`/employees/${e.id}/face-registration`).then((r) => r.data),
    enabled: can('people.read'),
    refetchInterval: 60_000,
  });
  const grant = status.data?.authorization;
  const available = grant?.usable === true;
  const streak = status.data?.manual_failure_streak;
  const registered = status.data?.face_registered ?? e.face.enrolled;
  const canEdit = can('people.write') && !e.read_only && e.status === 'ACTIVE' && registered && !!status.data && !status.isError;
  const approvedButUnavailable = grant?.status === 'APPROVED' && !available;
  const expired = approvedButUnavailable && new Date(grant.expires_at).getTime() <= Date.now();

  const changed = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['employee-face-registration', e.id] }),
      qc.invalidateQueries({ queryKey: ['employee', e.id] }),
      qc.invalidateQueries({ queryKey: ['tablet-people'] }),
    ]);
    setDialog(null);
    setReason('');
  };
  const approve = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/face-registration/authorize`, { reason: reason.trim() }),
    onSuccess: async () => {
      await changed();
      toast.success('Re-registration approved. The employee can use Register face at any site.');
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/face-registration/revoke`, { authorization_id: dialog.grantId }),
    onSuccess: async () => {
      await changed();
      toast.success('Re-registration permission cancelled.');
    },
  });
  const pending = approve.isPending || revoke.isPending;
  const close = () => { if (!pending) setDialog(null); };
  const open = (kind) => {
    approve.reset();
    revoke.reset();
    setReason('');
    setDialog({ kind, grantId: grant?.id });
  };

  return (
    <Card id="section-face">
      <CardHeader
        title="Face punch"
        description={!registered && !e.read_only ? 'Active employees register at any site.' : undefined}
        actions={canEdit && !available ? <Button variant="outline" size="sm" onClick={() => open('approve')}>Allow re-registration</Button> : undefined}
      />
      <CardBody className="flex flex-col gap-4">
        <KV cols={3} items={[
          ['Registered', registered && e.face.enrolled_at ? longDate(String(e.face.enrolled_at).slice(0, 10)) : '—'],
          ['Status', registered ? 'Ready to punch' : e.face.needs_registration ? <Chip tone="warning">Registration needed at a site</Chip> : <Chip tone="warning">Not registered</Chip>],
          ['Face samples', registered ? String(e.face.templates ?? '—') : '—'],
        ]} />
        {status.isError && <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]" role="alert"><span className="text-destructive">{errorMessage(status.error)}</span><Button variant="ghost" size="sm" onClick={() => status.refetch()}>Retry</Button></div>}
        {streak?.requires_review && !available && <Notice tone="warning">Face punching needed HR-approved manual attendance on {streak.days} consecutive days. Review the face registration.</Notice>}
        {available && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-2.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-primary">HR approved · ready at any site</p>
              <p className="mt-0.5 text-muted-foreground">Use Register face once. Expires {dateTime(grant.expires_at)}.</p>
              <p className="mt-0.5 text-muted-foreground">Approved {dateTime(grant.approved_at)}{grant.approved_by ? ` · ${grant.approved_by}` : ''}</p>
              {grant.reason && <p className="mt-1 break-words text-muted-foreground">{grant.reason}</p>}
            </div>
            {can('people.write') && <Button variant="ghost" size="sm" onClick={() => open('revoke')}>Cancel permission</Button>}
          </div>
        )}
        {expired && <p className="text-[13px] text-muted-foreground">Re-registration permission expired {dateTime(grant.expires_at)}.</p>}
        {approvedButUnavailable && !expired && <p className="text-[13px] text-muted-foreground">Re-registration is available only while the employee is active.</p>}
        {grant?.status === 'USED' && <p className="text-[13px] text-muted-foreground">Re-registration completed {dateTime(grant.used_at)}.</p>}
        {grant?.status === 'REVOKED' && <p className="text-[13px] text-muted-foreground">Re-registration permission cancelled {dateTime(grant.revoked_at)}.</p>}
      </CardBody>
      {dialog?.kind === 'approve' && (
        <Dialog open onOpenChange={(isOpen) => { if (!isOpen) close(); }} title="Allow face re-registration" description={`${e.name} can use Register face once at any site within 7 days.`} footer={
          <><Button variant="outline" disabled={pending} onClick={close}>Cancel</Button><Button loading={approve.isPending} disabled={reason.trim().length < 3} onClick={() => approve.mutate()}>Approve re-registration</Button></>
        }>
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-muted-foreground">The current face stays registered until the new photos pass the checks and are saved.</p>
            <Field label="Reason" required>{(id) => <Textarea id={id} autoFocus value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={300} placeholder="Why does this employee need to register again?" disabled={pending} />}</Field>
            {approve.isError && <Notice tone="destructive">{errorMessage(approve.error)}</Notice>}
          </div>
        </Dialog>
      )}
      {dialog?.kind === 'revoke' && (
        <Dialog open onOpenChange={(isOpen) => { if (!isOpen) close(); }} title="Cancel re-registration permission" description={`${e.name} will keep their current registered face.`} footer={
          <><Button variant="outline" disabled={pending} onClick={close}>Keep permission</Button><Button loading={revoke.isPending} onClick={() => revoke.mutate()}>Cancel permission</Button></>
        }>
          <p className="text-[14px] text-muted-foreground">The employee will no longer be able to replace their face through Register face.</p>
          {revoke.isError && <div className="mt-3"><Notice tone="destructive">{errorMessage(revoke.error)}</Notice></div>}
        </Dialog>
      )}
    </Card>
  );
}
