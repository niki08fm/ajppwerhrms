import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, Circle, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '@/lib/api';
import { embedAverage, FACE_MODEL_VERSION, loadFaceApi, startCamera, stopCamera } from '@/lib/face';
import { istTime } from '@/lib/utils';
import { Chip, Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Checkbox, Dialog } from '@/components/ui/overlay';

/** Six required steps, four optional. A step that needs data opens the thing it is about. */
export function OnboardingTab({ e }) {
  const qc = useQueryClient();
  const [, setSp] = useSearchParams();
  const [enrolling, setEnrolling] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['employee', e.id] });
  const goTab = (t) =>
    setSp((p) => {
      const n = new URLSearchParams(p);
      n.set('tab', t);
      return n;
    });

  const tick = useMutation({
    mutationFn: ({ code, done }) => api.post(`/employees/${e.id}/onboarding/${code}`, { done }),
    onSuccess: refresh,
    onError: (err, vars) => {
      const opens = err instanceof ApiError ? err.details?.opens : undefined;
      toast.message(errorMessage(err), { description: opens ? 'Opening it now.' : undefined });
      if (opens === 'face') setEnrolling(true);
      else if (opens === 'edit') goTab('overview');
      else if (opens === 'letters') goTab('letters');
      else if (opens === 'pay') goTab('pay');
      void vars;
    },
  });
  const activate = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/activate`),
    onSuccess: () => {
      toast.success(`${e.name} is active. They appear in attendance from their joining date and in the next payroll run.`);
      refresh();
      qc.invalidateQueries({ queryKey: ['people'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const ob = e.onboarding;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title="Onboarding checklist"
          description={`${ob.done} of ${ob.total} done. ${ob.required_left ? `${ob.required_left} required step${ob.required_left > 1 ? 's' : ''} left.` : 'All required steps are done.'}`}
        />
        <ul className="divide-y">
          {ob.items.map((it) => (
            <li key={it.code} className="flex items-center gap-3 px-4 py-2.5">
              <Checkbox label={it.label} checked={!!it.done_at} disabled={e.read_only || tick.isPending} onCheckedChange={(v) => tick.mutate({ code: it.code, done: v })} />
              <div className="flex-1">
                <div className="flex items-center gap-2 text-[13px]">
                  {it.label} {it.required ? <Chip tone="info">Required</Chip> : <Chip>Optional</Chip>}
                </div>
                {it.done_at && (
                  <div className="text-[12px] text-muted-foreground">
                    Done {istTime(it.done_at, true)} by {it.done_by}
                  </div>
                )}
              </div>
              {it.code === 'FACE' && !e.read_only && (
                <Button size="sm" variant="outline" onClick={() => setEnrolling(true)}>
                  <Camera /> {e.face.enrolled ? 'Re-enrol' : 'Enrol face'}
                </Button>
              )}
              {it.done_at ? <CheckCircle2 className="size-4 text-success" aria-label="Done" /> : <Circle className="size-4 text-muted-foreground" aria-label="Not done" />}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Activate" />
        <div className="flex flex-col gap-3 p-4 text-[13px]">
          {e.status === 'ONBOARDING' ? (
            <>
              <p className="text-muted-foreground">Nobody is paid before activation. Activating adds {e.name.split(' ')[0]} to attendance from the joining date and to the next payroll run.</p>
              <Button size="lg" disabled={ob.required_left > 0} loading={activate.isPending} onClick={() => activate.mutate()}>
                <Rocket /> {ob.required_left > 0 ? `${ob.required_left} required step${ob.required_left > 1 ? 's' : ''} remain` : 'Activate'}
              </Button>
            </>
          ) : (
            <p>
              Status: <strong>{e.status.toLowerCase()}</strong>.{' '}
              {e.status === 'ACTIVE' ? 'Activated.' : e.status === 'OFFER' || e.status === 'ACCEPTED' ? 'Start onboarding from Offers and onboarding.' : ''}
            </p>
          )}
        </div>
      </Card>
      {enrolling && <FaceEnrolDialog e={e} onClose={() => setEnrolling(false)} onDone={refresh} />}
    </div>
  );
}

function FaceEnrolDialog({ e, onClose, onDone }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState(null);

  useEffect(() => () => stopCamera(stream.current), []);

  const start = async () => {
    setState('loading');
    setMsg(null);
    try {
      await loadFaceApi();
      stream.current = await startCamera(video.current);
      setState('ready');
    } catch (err) {
      setState('error');
      setMsg(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow the camera in the browser and try again.'
          : 'The camera or the face models could not be loaded. Check the connection and try again.',
      );
    }
  };

  const capture = async () => {
    setState('capturing');
    const emb = await embedAverage(video.current);
    if (!emb) {
      setState('ready');
      setMsg('No single clear face was found. Face the camera, remove glasses or a helmet, and try again.');
      return;
    }
    try {
      await api.post(`/employees/${e.id}/face`, { embedding: emb, model_version: FACE_MODEL_VERSION, consent: true });
      toast.success('Face enrolled. Only the embedding is stored — no photograph.');
      stopCamera(stream.current);
      onDone();
      onClose();
    } catch (err) {
      setState('ready');
      setMsg(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Enrol ${e.name}'s face`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {state === 'idle' || state === 'error' ? (
            <Button disabled={!consent} onClick={start}>
              <Camera /> Start camera
            </Button>
          ) : (
            <Button disabled={state !== 'ready'} loading={state === 'capturing' || state === 'loading'} onClick={capture}>
              Capture and enrol
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <Notice tone="info">
          <p className="font-medium">How this data is kept</p>
          <p>
            A numeric face embedding is stored for matching at site gates — not a photograph. It is deleted automatically when {e.name.split(' ')[0]} leaves. Gate snapshots taken when a match fails
            are kept for 30 days for review, then deleted. Punch records are kept as employment records.
          </p>
        </Notice>
        <label className="flex items-start gap-2">
          <Checkbox label="Written consent" checked={consent} onCheckedChange={setConsent} disabled={state !== 'idle' && state !== 'error'} />
          <span>{e.name} has given written consent to face enrolment for attendance, and the signed form is on file. The time of consent is recorded.</span>
        </label>
        <video ref={video} className={`aspect-[4/3] w-full rounded-md bg-muted object-cover ${state === 'idle' ? 'hidden' : ''}`} muted playsInline />
        {msg && <Notice tone="destructive">{msg}</Notice>}
      </div>
    </Dialog>
  );
}
