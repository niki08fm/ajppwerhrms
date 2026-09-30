import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, CloudOff, LogOut, MapPin, RefreshCw, ScanFace, UserX } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { embed, loadFaceApi, snapshot, startCamera, stopCamera } from '@/lib/face';
import { useOnline } from '@/lib/hooks';
import { istTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Notice } from '@/components/states';

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device has no location service.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission was refused. Allow location for this site in the browser.' : 'Could not get a GPS fix. Move to open sky and try again.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

const DEVICE_KEY = 'ajpwer.device';
const QUEUE_KEY = 'ajpwer.queue';
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `tab-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'tab-unknown';
  }
}

const readQueue = () => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
};
const writeQueue = (q) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    // storage full: nothing more we can do on the device
  }
};

export default function Tablet() {
  const me = useQuery({ queryKey: ['site-me'], queryFn: () => api.get('/auth/site-me').then((r) => r.data), retry: false });
  if (me.isLoading) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  return me.data ? <Station site={me.data} /> : <SiteLogin />;
}

function SiteLogin() {
  const qc = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const pos = await getPosition();
      await api.post('/auth/site-login', { login: login.trim().toLowerCase(), password, ...pos });
      qc.invalidateQueries({ queryKey: ['site-me'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex items-center gap-2">
          <MapPin className="size-6 text-primary" />
          <h1 className="font-display text-2xl font-semibold">Site tablet</h1>
        </div>
        <p className="text-[13px] text-muted-foreground">Sign in with the site's own login. It works only inside the site's boundary.</p>
        {error && <Notice tone="destructive">{error}</Notice>}
        <Field label="Site login">{(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" className="h-11 text-base" required />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 text-base" required />}</Field>
        <Button type="submit" size="lg" loading={busy}>
          Sign in here
        </Button>
      </form>
    </div>
  );
}

function Station({ site }) {
  const qc = useQueryClient();
  const online = useOnline();
  const summary = useQuery({
    queryKey: ['tablet-summary'],
    queryFn: () => api.get('/tablet/summary').then((r) => r.data),
    refetchInterval: 60_000,
    enabled: online,
  });
  const [stage, setStage] = useState({ k: 'idle' });
  const [error, setError] = useState(null);
  const [queue, setQueue] = useState(readQueue);
  const video = useRef(null);
  const stream = useRef(null);

  const reset = useCallback(() => {
    stopCamera(stream.current);
    stream.current = null;
    setStage({ k: 'idle' });
  }, []);

  // Sync the offline queue when the connection returns, with the original times.
  const sync = useCallback(async () => {
    const q = readQueue();
    if (!q.length) return;
    const left = [];
    for (const item of q) {
      try {
        await api.post('/punches', { ...item, device_id: deviceId(), queued: true });
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) continue; // rejected for good (e.g. outside the fence): drop
        left.push(item);
      }
    }
    writeQueue(left);
    setQueue(left);
    qc.invalidateQueries({ queryKey: ['tablet-summary'] });
  }, [qc]);
  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);
  useEffect(() => () => stopCamera(stream.current), []);

  const begin = async () => {
    setError(null);
    setStage({ k: 'camera' });
    try {
      await loadFaceApi();
      stream.current = await startCamera(video.current, 'user');
    } catch {
      setError('The camera or face models could not start. Check camera permission and the connection.');
      reset();
    }
  };

  const capture = async () => {
    setStage({ k: 'checking' });
    setError(null);
    const at = new Date().toISOString();
    try {
      const [face, pos] = await Promise.all([embed(video.current), getPosition()]);
      const shot = snapshot(video.current);
      if (!face) {
        setError('No face found. Look straight at the camera, remove helmet or glasses, and try again.');
        setStage({ k: 'camera' });
        return;
      }
      if (!navigator.onLine) {
        setStage({ k: 'offline', emb: face.embedding, pos, at, shot });
        return;
      }
      const r = await api.post('/punches/identify', { embedding: face.embedding, ...pos });
      stopCamera(stream.current);
      if (r.data.matched) setStage({ k: 'matched', employee: r.data.employee, direction: r.data.direction, note: r.data.note ?? null, token: r.data.match_token, pos, at });
      else setStage({ k: 'unmatched', best: r.data.best_match_id ?? null, score: r.data.score ?? null, pos, at, shot });
    } catch (e) {
      setError(errorMessage(e));
      setStage({ k: 'camera' });
    }
  };

  const confirm = async (direction) => {
    if (stage.k !== 'matched') return;
    try {
      const r = await api.post(
        '/punches',
        { employee_id: stage.employee.id, direction, client_punched_at: stage.at, ...stage.pos, match_token: stage.token, device_id: deviceId() },
        { 'Idempotency-Key': `${stage.employee.id}-${stage.at}` },
      );
      setStage({ k: 'done', text: `${r.data.employee.name} — ${direction === 'IN' ? 'in' : 'out'} at ${istTime(r.data.punched_at)}` });
      qc.invalidateQueries({ queryKey: ['tablet-summary'] });
      setTimeout(reset, 3500);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const raise = async () => {
    if (stage.k !== 'unmatched') return;
    try {
      await api.post('/face-exceptions', { occurred_at: stage.at, best_match_id: stage.best, score: stage.score, reason: 'Not recognised at the gate', ...stage.pos, snapshot: stage.shot });
      setStage({ k: 'done', text: 'Sent to HR. Nobody is marked present until HR decides — at the time you stood here, not later.' });
      setTimeout(reset, 5000);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const queueOffline = (direction) => {
    if (stage.k !== 'offline') return;
    const q = [...readQueue(), { direction, client_punched_at: stage.at, ...stage.pos, embedding: stage.emb, snapshot: stage.shot }];
    writeQueue(q);
    setQueue(q);
    stopCamera(stream.current);
    setStage({ k: 'done', text: `Saved on this tablet at ${istTime(stage.at)}. It will be sent with its original time when the network returns.` });
    setTimeout(reset, 4000);
  };

  const signOut = async () => {
    await api.post('/auth/site-logout').catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['site-me'] });
  };

  const s = summary.data;
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div>
          <div className="font-display text-xl font-semibold">{site.name}</div>
          <div className="text-[12px] text-muted-foreground">{s?.date}</div>
        </div>
        <div className="flex items-center gap-2">
          {!online && (
            <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-3 py-1 text-[12px] text-destructive">
              <CloudOff className="size-4" /> Offline
            </span>
          )}
          {queue.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => void sync()} disabled={!online}>
              <RefreshCw /> {queue.length} waiting to send
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </header>
      <main className="grid flex-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <section className="flex flex-col items-center justify-center gap-5">
          {error && <Notice tone="destructive">{error}</Notice>}
          {stage.k === 'idle' && (
            <Button size="xl" className="h-40 w-full max-w-md flex-col gap-2 text-2xl" onClick={begin}>
              <ScanFace className="!size-12" /> Mark attendance
            </Button>
          )}
          <div className={stage.k === 'camera' || stage.k === 'checking' ? 'flex w-full max-w-lg flex-col items-center gap-3' : 'hidden'}>
            <video ref={video} className="aspect-[4/3] w-full rounded-xl border bg-muted object-cover" muted playsInline />
            <div className="flex gap-2">
              <Button variant="outline" size="lg" onClick={reset}>
                Cancel
              </Button>
              <Button size="lg" loading={stage.k === 'checking'} onClick={capture}>
                <Camera /> Capture
              </Button>
            </div>
          </div>
          {stage.k === 'matched' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <div className="flex size-20 items-center justify-center rounded-full bg-primary font-display text-3xl font-semibold text-primary-foreground">
                {stage.employee.name
                  .split(' ')
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join('')}
              </div>
              <div>
                <div className="font-display text-2xl font-semibold">{stage.employee.name}</div>
                <div className="text-muted-foreground">
                  {stage.employee.designation} · {stage.employee.code}
                </div>
              </div>
              {stage.note && <Notice>{stage.note}</Notice>}
              <div className="grid w-full grid-cols-2 gap-3">
                <Button size="xl" variant={stage.direction === 'IN' ? 'default' : 'outline'} onClick={() => confirm('IN')}>
                  In
                </Button>
                <Button size="xl" variant={stage.direction === 'OUT' ? 'default' : 'outline'} onClick={() => confirm('OUT')}>
                  Out
                </Button>
              </div>
              <button className="text-[13px] text-muted-foreground underline" onClick={reset}>
                Not me
              </button>
            </div>
          )}
          {stage.k === 'unmatched' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <UserX className="size-12 text-warning" />
              <div className="font-display text-xl font-semibold">We could not recognise you</div>
              <p className="text-muted-foreground">Try again facing the camera, or send this to HR. HR will check it and, if approved, mark you at this time.</p>
              <div className="flex gap-2">
                <Button size="lg" variant="outline" onClick={begin}>
                  Try again
                </Button>
                <Button size="lg" onClick={raise}>
                  Send to HR
                </Button>
              </div>
            </div>
          )}
          {stage.k === 'offline' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <CloudOff className="size-12 text-muted-foreground" />
              <div className="font-display text-xl font-semibold">No network</div>
              <p className="text-muted-foreground">Your punch is kept on this tablet with its true time and matched when the network returns.</p>
              <div className="grid w-full grid-cols-2 gap-3">
                <Button size="xl" onClick={() => queueOffline('IN')}>
                  In
                </Button>
                <Button size="xl" variant="outline" onClick={() => queueOffline('OUT')}>
                  Out
                </Button>
              </div>
            </div>
          )}
          {stage.k === 'done' && (
            <div className="flex flex-col items-center gap-3 text-center">
              <CheckCircle2 className="size-16 text-success" />
              <div className="font-display text-2xl font-semibold">{stage.text}</div>
            </div>
          )}
        </section>
        <aside className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border bg-card p-4 text-center">
              <div className="font-display text-3xl font-semibold num">{s?.on_site_now.length ?? '—'}</div>
              <div className="text-[12px] text-muted-foreground">on site now</div>
            </div>
            <div className="rounded-lg border bg-card p-4 text-center">
              <div className="font-display text-3xl font-semibold num">{s?.punched_in_today ?? '—'}</div>
              <div className="text-[12px] text-muted-foreground">in today</div>
            </div>
          </div>
          <div className="rounded-lg border bg-card">
            <div className="border-b px-4 py-2 text-[13px] font-semibold">On site now</div>
            <ul className="max-h-[50vh] divide-y overflow-y-auto text-[13px]">
              {s?.on_site_now.map((p) => (
                <li key={p.id} className="flex justify-between px-4 py-2">
                  <span>{p.name}</span>
                  <span className="text-muted-foreground num">{istTime(p.since)}</span>
                </li>
              ))}
              {s && !s.on_site_now.length && <li className="px-4 py-6 text-center text-muted-foreground">Nobody yet.</li>}
            </ul>
          </div>
          <p className="text-[11px] text-muted-foreground">Location is checked on every punch. Face data is used only to match; a snapshot is kept for 30 days only when HR needs to review.</p>
        </aside>
      </main>
    </div>
  );
}
