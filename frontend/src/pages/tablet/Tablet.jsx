import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, CheckCircle2, CloudOff, LogOut, MapPin, ScanFace, UserPlus, UserX } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/services/api';
import { capture, loadGuidance, messageFor, startCamera, stopCamera, waitForGoodFrame } from '@/services/face';
import { useOnline } from '@/hooks';
import { istTime } from '@/utils';
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
        <p className="text-[13px] text-muted-foreground">Sign in with the site's login ID and password. After that the tablet asks for its location: it works only inside the site's boundary.</p>
        {error && <Notice tone="destructive">{error}</Notice>}
        <Field label="Login ID">{(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" className="h-11 text-base" required />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 text-base" required />}</Field>
        <Button type="submit" size="lg" loading={busy}>
          Sign in here
        </Button>
        <p className="text-center text-[13px] text-muted-foreground">Forgot the password? Ask HR to reset it.</p>
      </form>
    </div>
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newRequestId = () => `req-${crypto.randomUUID()}`;

/** Upload the two frames; a busy face service is retried with the same request id (never a failed try). */
async function sendFrames(sessionId, front, turn, pos, requestId, onBusy) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.set('request_id', requestId);
    form.set('lat', String(pos.lat));
    form.set('lng', String(pos.lng));
    form.set('accuracy_m', String(pos.accuracy_m));
    form.append('front', front, 'front.jpg');
    form.append('turn', turn, 'turn.jpg');
    try {
      return (await api.post(`/punches/sessions/${sessionId}/frames`, form)).data;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'FACE_BUSY' && attempt < 10) {
        onBusy();
        await sleep(1200 + attempt * 300);
        continue;
      }
      throw e;
    }
  }
}

/**
 * The punch station (face/INTEGRATION.md §4): the browser guides and captures; the
 * server decides. Look straight → turn as asked → "Is this you?" → punch in or out,
 * "This is not me", or Change site. After the last try, the ID and name form.
 */
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
  const [hint, setHint] = useState('');
  const [error, setError] = useState(null);
  const video = useRef(null);
  const stream = useRef(null);
  const abort = useRef(null);
  const session = useRef(null);

  const stop = useCallback(() => {
    abort.current?.abort();
    stopCamera(stream.current);
    stream.current = null;
  }, []);
  const reset = useCallback(() => {
    stop();
    session.current = null;
    setHint('');
    setStage({ k: 'idle' });
  }, [stop]);
  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    if (!online && stage.k !== 'idle' && stage.k !== 'done') {
      stop();
      setStage({ k: 'idle' });
    }
  }, [online, stage.k, stop]);

  const finish = (text, ms = 4000) => {
    stop();
    session.current = null;
    setStage({ k: 'done', text });
    qc.invalidateQueries({ queryKey: ['tablet-summary'] });
    setTimeout(reset, ms);
  };

  const fail = (e) => {
    stop();
    setError(e instanceof ApiError && e.code === 'NETWORK' ? messageFor('OFFLINE') : errorMessage(e));
    setStage((s) => (s.k === 'camera' || s.k === 'checking' ? { k: 'retry', text: null } : s));
  };

  /** One scan in the current session: straight frame, then the head turn the server asked for. */
  const scan = async () => {
    setError(null);
    const sess = session.current;
    setStage({ k: 'camera', purpose: sess.purpose });
    try {
      if (!stream.current) {
        await loadGuidance();
        stream.current = await startCamera(video.current, 'user');
      }
      abort.current = new AbortController();
      const ok = await waitForGoodFrame(video.current, { onHint: (r) => setHint(r.ok ? messageFor('LOOK_STRAIGHT') : r.message), signal: abort.current.signal });
      if (!ok) return fail(new Error(messageFor('NO_FACE')));
      const front = await capture(video.current);
      setHint(messageFor(sess.challenge.direction === 'LEFT' ? 'TURN_LEFT' : 'TURN_RIGHT'));
      await sleep(1800);
      const turn = await capture(video.current);
      setHint('');
      setStage({ k: 'checking' });
      const pos = await getPosition();
      const d = await sendFrames(sess.id, front, turn, pos, newRequestId(), () => setHint(messageFor('BUSY')));
      handle(d, pos);
    } catch (e) {
      if (e?.name === 'NotAllowedError') return fail(new Error(messageFor('CAMERA_BLOCKED')));
      fail(e);
    }
  };

  const handle = (d, pos) => {
    const sess = session.current;
    if (d.challenge) sess.challenge = d.challenge;
    if (d.outcome === 'IDENTIFIED') {
      stop();
      setStage({ k: 'identified', d, pos });
    } else if (d.outcome === 'REGISTERED') finish(d.message, 5000);
    else if (d.outcome === 'DUPLICATE' || d.outcome === 'DUPLICATE_FACE') finish(d.message, 5000);
    else if (d.status === 'BLOCKED') {
      stop();
      setStage({ k: 'blocked', text: d.message });
    } else {
      stop();
      setStage({ k: 'retry', text: d.message, triesLeft: d.tries_left });
    }
  };

  const begin = async (purpose = 'PUNCH', who = null) => {
    setError(null);
    try {
      const pos = await getPosition();
      const r = await api.post('/punches/sessions', { purpose, ...(who ?? {}), ...pos });
      session.current = { id: r.data.session_id, purpose, challenge: r.data.challenge };
      await scan();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'NETWORK' ? messageFor('OFFLINE') : errorMessage(e));
    }
  };

  const act = async (fn) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'CONFIRM_EXPIRED' || e.code === 'CONFLICT')) {
        setStage({ k: 'retry', text: messageFor('CHALLENGE_EXPIRED') });
        return;
      }
      setError(e instanceof ApiError && e.code === 'NETWORK' ? messageFor('OFFLINE') : errorMessage(e));
    }
  };

  const confirmPunch = () =>
    act(async () => {
      const pos = await getPosition();
      const r = await api.post(`/punches/sessions/${session.current.id}/confirm`, { confirm_token: stage.d.confirm_token, device_id: deviceId(), ...pos });
      finish(r.data.message);
    });

  const notMe = () =>
    act(async () => {
      const r = await api.post(`/punches/sessions/${session.current.id}/not-me`, { confirm_token: stage.d.confirm_token });
      handle(r.data, stage.pos);
    });

  const changeSite = (toSite) =>
    act(async () => {
      const pos = await getPosition();
      const r = await api.post(`/punches/sessions/${session.current.id}/change-site`, { confirm_token: stage.d.confirm_token, to_site_id: toSite.id, ...pos });
      finish(r.data.message, 6000);
    });

  const manual = (code, name) =>
    act(async () => {
      const pos = await getPosition();
      const r = await api.post(`/punches/sessions/${session.current.id}/manual`, { employee_code: code, name, ...pos });
      finish(r.data.message, 5000);
    });

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
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        </div>
      </header>
      <main className="grid flex-1 gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <section className="flex flex-col items-center justify-center gap-5">
          {!online && <Notice tone="destructive">{messageFor('OFFLINE')}</Notice>}
          {error && online && <Notice tone="destructive">{error}</Notice>}
          {stage.k === 'idle' && (
            <div className="flex w-full max-w-md flex-col gap-3">
              <Button size="xl" className="h-40 w-full flex-col gap-2 text-2xl" disabled={!online} onClick={() => begin('PUNCH')}>
                <ScanFace className="!size-12" /> Mark attendance
              </Button>
              <Button size="lg" variant="outline" disabled={!online} onClick={() => setStage({ k: 'register' })}>
                <UserPlus /> Register face
              </Button>
            </div>
          )}
          {stage.k === 'register' && <RegisterForm onCancel={reset} onStart={(who) => begin('REGISTER', who)} />}
          <div className={stage.k === 'camera' || stage.k === 'checking' ? 'flex w-full max-w-lg flex-col items-center gap-3' : 'hidden'}>
            <div className="relative w-full">
              <video ref={video} className="aspect-[4/3] w-full -scale-x-100 rounded-xl border bg-muted object-cover" muted playsInline />
              <div className="pointer-events-none absolute left-1/2 top-[45%] h-[70%] w-[42%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-4 border-primary/80" aria-hidden />
            </div>
            <div className="min-h-8 text-center font-display text-xl font-semibold" aria-live="polite">
              {stage.k === 'checking' ? hint || messageFor('CHECKING') : hint}
            </div>
            <Button variant="outline" size="lg" onClick={reset}>
              Cancel
            </Button>
          </div>
          {stage.k === 'identified' && (
            <Confirmation d={stage.d} onConfirm={confirmPunch} onNotMe={notMe} onChangeSite={() => setStage({ ...stage, k: 'change-site' })} />
          )}
          {stage.k === 'change-site' && <ChangeSite onPick={changeSite} onBack={() => setStage({ ...stage, k: 'identified' })} />}
          {stage.k === 'retry' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <UserX className="size-12 text-warning" />
              {stage.text && <div className="font-display text-xl font-semibold">{stage.text}</div>}
              {stage.triesLeft !== undefined && <p className="text-muted-foreground">Tries left: {stage.triesLeft}</p>}
              <div className="flex gap-2">
                <Button size="lg" variant="outline" onClick={reset}>
                  Cancel
                </Button>
                <Button size="lg" disabled={!online} onClick={() => (session.current ? scan() : begin())}>
                  Try again
                </Button>
              </div>
            </div>
          )}
          {stage.k === 'blocked' && <ManualForm text={stage.text} onSend={manual} onCancel={reset} />}
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
          <p className="text-[11px] text-muted-foreground">
            Location is checked on every punch. The camera pictures are checked on our server and not kept; only when the face check fails five times are small face crops kept for HR, for 30 days.
          </p>
        </aside>
      </main>
    </div>
  );
}

/** "Is this you?" — the existing confirmation card, with one punch button for the direction the server worked out. */
function Confirmation({ d, onConfirm, onNotMe, onChangeSite }) {
  const [busy, setBusy] = useState(false);
  const run = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
      <div className="text-muted-foreground">{d.message}</div>
      <div className="flex size-20 items-center justify-center rounded-full bg-primary font-display text-3xl font-semibold text-primary-foreground">
        {d.employee.name
          .split(' ')
          .map((w) => w[0])
          .slice(0, 2)
          .join('')}
      </div>
      <div>
        <div className="font-display text-2xl font-semibold">{d.employee.name}</div>
        <div className="text-muted-foreground">
          {d.employee.designation} · {d.employee.code}
        </div>
      </div>
      {d.note && <Notice>{d.note}</Notice>}
      <Button size="xl" className="w-full" loading={busy} onClick={run(onConfirm)}>
        {d.direction === 'IN' ? 'Punch in' : 'Punch out'}
      </Button>
      {d.can_change_site && (
        <Button size="lg" variant="outline" className="w-full" disabled={busy} onClick={onChangeSite}>
          <ArrowRightLeft /> Change site
        </Button>
      )}
      <button className="text-[14px] text-muted-foreground underline" disabled={busy} onClick={run(onNotMe)}>
        This is not me
      </button>
    </div>
  );
}

/** Leaving for another site: pick it; this punches out here. Travel counts if he punches in there today. */
function ChangeSite({ onPick, onBack }) {
  const sites = useQuery({ queryKey: ['tablet-sites'], queryFn: () => api.get('/tablet/sites').then((r) => r.data) });
  const [busy, setBusy] = useState(null);
  return (
    <div className="flex w-full max-w-lg flex-col gap-3 rounded-xl border bg-card p-6">
      <div className="font-display text-xl font-semibold">Which site are you going to?</div>
      <p className="text-[13px] text-muted-foreground">You are punched out here now. Your travel time counts if you punch in at that site today.</p>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {sites.data?.map((x) => (
          <Button
            key={x.id}
            size="lg"
            variant="outline"
            className="justify-start"
            loading={busy === x.id}
            disabled={!!busy}
            onClick={async () => {
              setBusy(x.id);
              try {
                await onPick(x);
              } finally {
                setBusy(null);
              }
            }}
          >
            {x.name}
          </Button>
        ))}
        {sites.data && !sites.data.length && <p className="text-muted-foreground">No other sites.</p>}
      </div>
      <Button variant="ghost" onClick={onBack} disabled={!!busy}>
        Back
      </Button>
    </div>
  );
}

function RegisterForm({ onStart, onCancel }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onStart({ employee_code: code.trim(), name: name.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="font-display text-xl font-semibold">Register face</div>
      <p className="text-[13px] text-muted-foreground">Once only, at any site. Then you punch with your face everywhere.</p>
      <Field label="Employee ID">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} className="h-11 text-base" autoCapitalize="characters" required />}</Field>
      <Field label="Your name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} className="h-11 text-base" required />}</Field>
      <div className="flex gap-2">
        <Button variant="outline" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="flex-1" loading={busy}>
          Start
        </Button>
      </div>
    </form>
  );
}

/** After the last try: employee ID and name go to HR as a manual request, with the face crops. */
function ManualForm({ text, onSend, onCancel }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSend(code.trim(), name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6">
      <UserX className="size-10 text-warning" />
      <p className="font-display text-lg font-semibold">{text}</p>
      <Field label="Employee ID">{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} className="h-11 text-base" autoCapitalize="characters" required />}</Field>
      <Field label="Your name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} className="h-11 text-base" required />}</Field>
      <div className="flex gap-2">
        <Button variant="outline" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="flex-1" loading={busy}>
          Send to HR
        </Button>
      </div>
    </form>
  );
}
