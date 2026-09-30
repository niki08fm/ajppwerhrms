import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, FileUp, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { DOCUMENT_TYPES } from '@ajpwer/shared';
import { api, API_BASE, errorMessage } from '@/services/api';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

export const docLabel = (t) =>
  t
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

export function DocumentsTab({ e }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['documents', e.id], queryFn: () => api.get(`/employees/${e.id}/documents`).then((r) => r.data) });
  const verify = useMutation({
    mutationFn: (id) => api.post(`/employees/${e.id}/documents/${id}/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents', e.id] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card>
      <CardHeader
        title="Documents"
        actions={
          !e.read_only && (
            <Button onClick={() => setAdding(true)}>
              <FileUp /> Add document
            </Button>
          )
        }
      />

      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState title="No documents collected" body="Add PAN, Aadhaar, bank proof and certificates as they are collected." action={<Button onClick={() => setAdding(true)}>Add document</Button>} />
      ) : (
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Document</th>
              <th>Collected</th>
              <th>Expires</th>
              <th>Verified</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((d) => (
              <tr key={d.id}>
                <td>{docLabel(d.doc_type)}</td>
                <td className="num">{d.collected_on}</td>
                <td className="num">{d.expires_on ? d.expires_on < today ? <Chip tone="destructive">Expired {d.expires_on}</Chip> : d.expires_on : '—'}</td>
                <td>
                  {d.verified_at ? (
                    <Chip tone="success">
                      <BadgeCheck className="size-3" /> Verified
                    </Chip>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => verify.mutate(d.id)} disabled={e.read_only}>
                      Mark verified
                    </Button>
                  )}
                </td>
                <td>
                  {d.has_file ? (
                    <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`${API_BASE}/employees/${e.id}/documents/${d.id}/file`} target="_blank" rel="noreferrer">
                      <Paperclip className="size-3.5" /> {d.file_name ?? 'Open'}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">No file</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && <AddDocDialog e={e} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AddDocDialog({ e, onClose }) {
  const qc = useQueryClient();
  const file = useRef(null);
  const [f, setF] = useState({ doc_type: 'PAN', collected_on: new Date().toISOString().slice(0, 10), expires_on: '' });
  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('doc_type', f.doc_type);
      fd.set('collected_on', f.collected_on);
      if (f.expires_on) fd.set('expires_on', f.expires_on);
      if (file.current?.files?.[0]) fd.set('file', file.current.files[0]);
      return api.post(`/employees/${e.id}/documents`, fd);
    },
    onSuccess: () => {
      toast.success('Document added');
      qc.invalidateQueries({ queryKey: ['documents', e.id] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a document"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.doc_type} onChange={(ev) => setF({ ...f, doc_type: ev.target.value })}>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {docLabel(t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Collected on">{(id) => <Input id={id} type="date" value={f.collected_on} onChange={(ev) => setF({ ...f, collected_on: ev.target.value })} />}</Field>
        <Field label="Expires on" hint="Leave blank if it does not expire">
          {(id) => <Input id={id} type="date" value={f.expires_on} onChange={(ev) => setF({ ...f, expires_on: ev.target.value })} />}
        </Field>
        <Field label="File" hint="PDF, PNG, JPEG or WebP, up to 10 MB">
          {(id) => <Input id={id} ref={file} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="py-1" />}
        </Field>
      </div>
    </Dialog>
  );
}
