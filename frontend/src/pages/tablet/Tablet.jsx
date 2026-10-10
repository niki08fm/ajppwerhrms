import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CloudOff, EyeOff, Loader2, MapPin, RotateCcw, UserX } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/services/api';
import { capture, loadGuidance, loadLandmarks, messageFor, startCamera, stopCamera, waitForBlink, waitForGoodFrame, waitForHeadTurn, waitForStraight } from '@/services/face';
import { getPosition } from '@/services/location';
import { useDebounced, useOnline } from '@/hooks';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Chip, Notice } from '@/components/states';
import { TabletDashboard } from '@/components/tablet/TabletDashboard';

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
      await api.post('/auth/site-login', { login: login.trim().toLowerCase(), password });
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
        <p className="text-[14px] text-muted-foreground">Sign in from anywhere to view this site's attendance. Location is checked before punching or registering a face.</p>
        {error && <Notice tone="destructive">{error}</Notice>}
        <Field label="Login ID">{(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" className="h-11 text-base" required />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 text-base" required />}</Field>
        <Button type="submit" size="lg" loading={busy}>
          Sign in here
        </Button>
        <p className="text-center text-[14px] text-muted-foreground">Forgot the password? Ask HR to reset it.</p>
      </form>
    </div>
  );
}

/**
 * Where the oval goes on screen. The camera picture fills the screen and is cropped to fit,
 * so the oval is placed where the face-finder expects the face — middle, a little above
 * centre, about 40% of the picture's width — mapped through that crop.
 */
function useOval(video, active) {
  const [oval, setOval] = useState(null);
  useEffect(() => {
    const el = video.current;
    if (!active || !el) return undefined;
    const update = () => {
      const [vw, vh, cw, ch] = [el.videoWidth, el.videoHeight, el.clientWidth, el.clientHeight];
      if (!vw || !vh || !cw || !ch) return;
      const scale = Math.max(cw / vw, ch / vh);
      const width = Math.min(0.4 * vw * scale, cw * 0.78, (ch * 0.62) / 1.3);
      setOval({ left: cw / 2, top: ch / 2 + (0.45 * vh - vh / 2) * scale, width, height: width * 1.3 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('loadedmetadata', update);
    const t = setInterval(update, 400);
    return () => {
      ro.disconnect();
      el.removeEventListener('loadedmetadata', update);
      clearInterval(t);
    };
  }, [active, video]);
  return oval;
}

const REGISTER_STEPS = ['Look straight', 'Turn left', 'Turn right', 'Blink'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newRequestId = () => `req-${crypto.randomUUID()}`;

/** A busy face service is retried with the same frames and request ID. */
async function sendFrames(sessionId, pictures, pos, requestId, onBusy) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.set('request_id', requestId);
    form.set('lat', String(pos.lat));
    form.set('lng', String(pos.lng));
    form.set('accuracy_m', String(pos.accuracy_m));
    for (const [name, blob] of Object.entries(pictures)) form.append(name, blob, `${name}.jpg`);
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
 * The site workspace opens a scan only when Punch or Register face is chosen.
 * The browser guides capture; the server checks identity and chooses IN or OUT.
 */
function Station({ site }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [stage, setStage] = useState({ k: 'idle' });
  const [hint, setHint] = useState('');
  // Where the person is in the capture: step 1 look straight, step 2 turn; how far along; which way.
  const [step, setStep] = useState({ n: 1, progress: 0, good: false });
  const blinkSkip = useRef({ requested: false });
  const [error, setError] = useState(null);
  const video = useRef(null);
  const stream = useRef(null);
  const abort = useRef(null);
  const session = useRef(null);
  const previews = useRef({});
  const finishTimer = useRef(null);
  const flow = useRef(0);

  const [cameraOn, setCameraOn] = useState(false);
  const oval = useOval(video, cameraOn);
  const stop = useCallback(() => {
    abort.current?.abort();
    stopCamera(stream.current);
    stream.current = null;
  }, []);
  const reset = useCallback(() => {
    flow.current += 1;
    stop();
    clearTimeout(finishTimer.current);
    Object.values(previews.current).forEach((url) => URL.revokeObjectURL(url));
    previews.current = {};
    session.current = null;
    setHint('');
    setError(null);
    setStage({ k: 'idle' });
  }, [stop]);
  useEffect(() => () => {
    flow.current += 1;
    session.current = null;
    stop();
    clearTimeout(finishTimer.current);
    Object.values(previews.current).forEach((url) => URL.revokeObjectURL(url));
  }, [stop]);
  useEffect(() => {
    setCameraOn(stage.k === 'camera' || stage.k === 'checking');
  }, [stage.k]);
  useEffect(() => {
    if (!online && stage.k !== 'idle' && stage.k !== 'done') {
      reset();
    }
  }, [online, stage.k, reset]);

  const finish = (text, ms = 4000) => {
    stop();
    session.current = null;
    setStage({ k: 'done', text });
    qc.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith('tablet-') });
    finishTimer.current = setTimeout(reset, ms);
  };

  const fail = (e) => {
    stop();
    setError(e instanceof ApiError && e.code === 'NETWORK' ? messageFor('OFFLINE') : errorMessage(e));
    setStage((s) => (s.k === 'camera' || s.k === 'checking' || s.k === 'sending' ? { k: 'retry', text: null } : s));
  };

  /**
   * A punch: look at the camera and hold still. Three pictures are taken a third of a second
   * apart and the server decides who it is and whether it is a live face and not a photo.
   * There is nothing else to do: no head turn.
   */
  const scan = async () => {
    setError(null);
    const sess = session.current;
    if (!sess) return;
    const current = () => session.current?.id === sess.id;
    setStage({ k: 'camera', purpose: sess.purpose });
    setStep({ n: 1, progress: 0, good: false });
    try {
      if (!stream.current) {
        setHint(messageFor('LOOK_AT_CAMERA'));
        await loadGuidance();
        await new Promise(requestAnimationFrame);
        if (!current()) return;
        const camera = await startCamera(video.current, 'user');
        if (!current()) { stopCamera(camera); return; }
        stream.current = camera;
      }
      abort.current = new AbortController();
      const signal = abort.current.signal;
      const ok = await waitForGoodFrame(video.current, {
        stable: 6,
        onHint: (r) => {
          setHint(r.ok ? messageFor('HOLD_STILL') : r.message);
          setStep((st) => ({ ...st, good: r.ok }));
        },
        onProgress: (p) => setStep((st) => ({ ...st, progress: p })),
        signal,
      });
      if (!ok) return signal.aborted ? undefined : fail(new Error(messageFor('NO_FACE')));
      const pictures = {};
      for (const name of ['front', 'front2', 'front3']) {
        if (signal.aborted || !current()) return;
        pictures[name] = await capture(video.current);
        if (name !== 'front3') await sleep(350);
      }
      setHint('');
      await send(pictures, 'checking');
    } catch (e) {
      if (!current()) return;
      if (e?.name === 'NotAllowedError') return fail(new Error(messageFor('CAMERA_BLOCKED')));
      fail(e);
    }
  };

  /**
   * Registering a face, step by step, at the person's pace: 1 look straight at the camera,
   * 2 turn to your left, 3 turn to your right, 4 close your eyes and open them. Each picture
   * is taken only when its step is seen done. A step that is not managed can be tried again
   * on its own; the pictures already taken are kept. Then step 5: check all four photos.
   */
  const registration = useRef({ photos: {} });
  const registerScan = async (from = 1) => {
    setError(null);
    const sess = session.current;
    if (!sess) return;
    const current = () => session.current?.id === sess.id;
    if (from === 1) registration.current = { photos: {} };
    const r = registration.current;
    setStage({ k: 'camera', purpose: 'REGISTER' });
    try {
      if (!stream.current) {
        setHint(messageFor('LOOK_STRAIGHT'));
        await loadLandmarks();
        await new Promise(requestAnimationFrame);
        if (!current()) return;
        const camera = await startCamera(video.current, 'user');
        if (!current()) { stopCamera(camera); return; }
        stream.current = camera;
      }
      abort.current = new AbortController();
      const signal = abort.current.signal;
      const follow = {
        onHint: (h) => {
          setHint(h.message);
          setStep((st) => ({ ...st, good: h.ok }));
        },
        onProgress: (p) => setStep((st) => ({ ...st, progress: p })),
        signal,
      };
      const stuck = (n, code) => {
        if (signal.aborted) return;
        stop();
        setHint('');
        setStage({ k: 'step-retry', step: n, text: messageFor(code) });
      };
      if (from <= 1) {
        setStep({ n: 1, progress: 0, good: false });
        setHint(messageFor('LOOK_STRAIGHT'));
        const st = await waitForStraight(video.current, follow);
        if (!st) return stuck(1, 'NO_FACE');
        r.photos.front = await capture(video.current);
        r.frontYaw = st.yaw;
      }
      for (const [n, dir, name] of [
        [2, 'LEFT', 'left'],
        [3, 'RIGHT', 'right'],
      ]) {
        if (from > n) continue;
        setStep({ n, progress: 0, good: false, dir });
        setHint(messageFor(dir === 'LEFT' ? 'TURN_LEFT' : 'TURN_RIGHT'));
        const t = await waitForHeadTurn(video.current, { fromYaw: r.frontYaw, direction: dir, ...follow });
        if (!t) return stuck(n, dir === 'LEFT' ? 'TURN_LEFT_NOT_SEEN' : 'TURN_RIGHT_NOT_SEEN');
        r.photos[name] = await capture(video.current);
      }
      setStep({ n: 4, progress: 0, good: false, blink: true, canSkip: false });
      setHint(messageFor('BLINK'));
      blinkSkip.current = { requested: false };
      const b = await waitForBlink(video.current, { fromYaw: r.frontYaw, skip: blinkSkip.current, onSlow: () => setStep((st) => ({ ...st, canSkip: true })), ...follow });
      if (!b) return stuck(4, 'BLINK_NOT_SEEN');
      r.photos.blink = b.blob;
      if (signal.aborted || !current()) return;
      stop();
      setHint('');
      Object.values(previews.current).forEach((url) => URL.revokeObjectURL(url));
      previews.current = Object.fromEntries(Object.entries(r.photos).map(([k, blob]) => [k, URL.createObjectURL(blob)]));
      setStage({ k: 'review', urls: previews.current });
    } catch (e) {
      if (!current()) return;
      if (e?.name === 'NotAllowedError') return fail(new Error(messageFor('CAMERA_BLOCKED')));
      fail(e);
    }
  };

  /** Send the pictures; the server decides. */
  const send = async (pictures, k) => {
    const sess = session.current;
    if (!sess) return;
    setStage({ k });
    const pos = await getPosition();
    if (session.current?.id !== sess.id) return;
    const d = await sendFrames(sess.id, pictures, pos, newRequestId(), () => {
      if (session.current?.id === sess.id) setHint(messageFor('BUSY'));
    });
    if (session.current?.id !== sess.id) return;
    handle(d, pos);
  };

  const dropPreviews = () => {
    Object.values(previews.current).forEach((url) => URL.revokeObjectURL(url));
    previews.current = {};
  };

  /** Registering: the person has looked at the four photos. Use them, or take them again. */
  const review = async (use) => {
    dropPreviews();
    if (!use) return registerScan(1);
    try {
      await send(registration.current.photos, 'sending');
    } catch (e) {
      fail(e);
    }
  };

  const handle = (d, pos) => {
    const sess = session.current;
    if (!sess) return;
    if (d.challenge) sess.challenge = d.challenge;
    if (d.outcome === 'IDENTIFIED') {
      stop();
      setStage({ k: 'identified', d, pos });
    } else if (d.outcome === 'REGISTERED') finish(d.message, 5000);
    else if (d.outcome === 'DUPLICATE' || d.outcome === 'DUPLICATE_FACE') finish(d.message, 5000);
    else if (d.status === 'BLOCKED') {
      stop();
      setStage(sess.purpose === 'REGISTER'
        ? { k: 'registration-blocked', replacement: sess.reRegistration }
        : { k: 'blocked', text: d.message });
    } else {
      stop();
      setStage({ k: 'retry', text: d.message, triesLeft: d.tries_left });
    }
  };

  const begin = async (purpose = 'PUNCH', who = null) => {
    const currentFlow = ++flow.current;
    setError(null);
    setStage({ k: 'starting', purpose });
    try {
      const pos = await getPosition();
      if (flow.current !== currentFlow) return;
      const r = await api.post('/punches/sessions', { purpose, ...(who ?? {}), ...pos });
      if (flow.current !== currentFlow) return;
      session.current = { id: r.data.session_id, purpose, who, challenge: r.data.challenge, reRegistration: r.data.re_registration === true };
      await (purpose === 'REGISTER' ? registerScan(1) : scan());
    } catch (e) {
      if (flow.current !== currentFlow) return;
      setError(e instanceof ApiError && e.code === 'NETWORK' ? messageFor('OFFLINE') : errorMessage(e));
      setStage({ k: 'idle' });
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

  const manual = (code, name) =>
    act(async () => {
      const pos = await getPosition();
      const r = await api.post(`/punches/sessions/${session.current.id}/manual`, { employee_code: code, name, ...pos });
      finish(r.data.message, 5000);
    });

  const signOut = async () => {
    setError(null);
    try {
      await api.post('/auth/site-logout');
      qc.removeQueries({ predicate: (query) => String(query.queryKey[0]).startsWith('tablet-') });
      qc.setQueryData(['site-me'], null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (stage.k === 'idle') return (
    <>
      {error && <div className="px-4 pt-4 sm:px-6"><Notice tone="destructive">{error}</Notice></div>}
      <TabletDashboard site={site} online={online} onPunch={() => begin('PUNCH')} onRegister={() => { setError(null); setStage({ k: 'register' }); }} onSignOut={signOut} />
    </>
  );
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Back to site attendance" onClick={reset}><ArrowLeft /></Button>
          <div>
          <div className="font-display text-xl font-semibold">{site.name}</div>
          <div className="text-[13px] text-muted-foreground">{stage.k === 'register' || session.current?.purpose === 'REGISTER' ? 'Register face' : 'Punch attendance'}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!online && (
            <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-3 py-1 text-[13px] text-destructive">
              <CloudOff className="size-4" /> Offline
            </span>
          )}
        </div>
      </header>
      <main className="flex flex-1 justify-center p-4 sm:p-6">
        <section className="flex flex-col items-center justify-center gap-5">
          {!online && <Notice tone="destructive">{messageFor('OFFLINE')}</Notice>}
          {error && online && <Notice tone="destructive">{error}</Notice>}
          {stage.k === 'starting' && <div className="flex flex-col items-center gap-3" aria-live="polite"><Loader2 className="size-10 animate-spin text-primary" /><p className="text-muted-foreground">Opening camera…</p></div>}
          {stage.k === 'register' && <RegisterForm onCancel={reset} onStart={(who) => begin('REGISTER', who)} />}
          {/* The camera fills the screen; only the button below stays. */}
          <div className={stage.k === 'camera' || stage.k === 'checking' ? 'fixed inset-0 z-40 flex flex-col bg-black text-white' : 'hidden'} style={{ height: '100dvh' }}>
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <video ref={video} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" muted playsInline />
              {oval && (
                <div
                  className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-4 shadow-[0_0_0_9999px_rgba(0,0,0,0.38)] transition-colors ${step.good ? 'border-success' : 'border-white/80'}`}
                  style={{ left: oval.left, top: oval.top, width: oval.width, height: oval.height }}
                  aria-hidden
                />
              )}
              {stage.k === 'camera' && step.dir && (
                // The picture is mirrored, so the person's own left is the screen's left.
                <div className={`pointer-events-none absolute top-[45%] -translate-y-1/2 animate-pulse rounded-full bg-primary/90 p-4 text-primary-foreground shadow-lg ${step.dir === 'LEFT' ? 'left-3' : 'right-3'}`} aria-hidden>
                  {step.dir === 'LEFT' ? <ArrowLeft className="size-12" /> : <ArrowRight className="size-12" />}
                </div>
              )}
              {stage.k === 'camera' && step.blink && (
                <div className="pointer-events-none absolute top-[14%] left-1/2 -translate-x-1/2 animate-pulse rounded-full bg-primary/90 p-4 text-primary-foreground shadow-lg" aria-hidden>
                  <EyeOff className="size-10" />
                </div>
              )}
              {stage.k === 'camera' && (
                <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-8 text-center text-[13px] font-semibold tracking-wide uppercase">
                  {stage.purpose === 'REGISTER' ? `Step ${step.n} of 4 · ${REGISTER_STEPS[step.n - 1]}` : 'Punch attendance'}
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-5 pt-10 pb-4">
                <div className="min-h-9 text-center font-display text-2xl leading-snug font-semibold [text-shadow:0_1px_6px_rgba(0,0,0,0.8)]" aria-live="polite">
                  {stage.k === 'checking' ? hint || messageFor('CHECKING') : hint}
                </div>
                {stage.k === 'camera' && (
                  <div className="h-2.5 w-full max-w-md overflow-hidden rounded-full bg-white/25" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(step.progress * 100)}>
                    <div className="h-full rounded-full bg-success transition-[width] duration-150" style={{ width: `${Math.round(step.progress * 100)}%` }} />
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-center gap-3 bg-black px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button variant="outline" size="lg" className="border-white/40 bg-transparent text-white hover:bg-white/10" onClick={reset}>
                Cancel
              </Button>
              {stage.k === 'camera' && step.blink && step.canSkip && (
                <Button size="lg" onClick={() => (blinkSkip.current.requested = true)}>
                  Take the photo now
                </Button>
              )}
            </div>
          </div>
          {stage.k === 'identified' && (
            <Confirmation d={stage.d} onConfirm={confirmPunch} onNotMe={notMe} />
          )}
          {stage.k === 'review' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <div className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">Ready to register</div>
              <div className="font-display text-xl font-semibold">{messageFor('CHECK_PHOTOS')}</div>
              <div className="grid w-full grid-cols-2 gap-3">
                {[
                  ['front', 'Looking straight'],
                  ['left', 'Turned left'],
                  ['right', 'Turned right'],
                  ['blink', 'Eyes closed'],
                ].map(([k, label]) => (
                  <figure key={k}>
                    <img src={stage.urls[k]} alt={label} className="aspect-[4/3] w-full -scale-x-100 rounded-lg border object-cover" />
                    <figcaption className="mt-1 text-[13px] text-muted-foreground">{label}</figcaption>
                  </figure>
                ))}
              </div>
              <p className="text-[14px] text-muted-foreground">Your whole face in every picture, nothing covering it, not blurred? If not, take them again.</p>
              {session.current?.reRegistration && <p className="text-[13px] text-muted-foreground">HR-approved re-registration. Your current face is replaced only after these photos pass the checks.</p>}
              <div className="flex w-full gap-2">
                <Button size="lg" variant="outline" className="flex-1" onClick={() => review(false)}>
                  <RotateCcw /> Retake
                </Button>
                <Button size="lg" className="flex-1" disabled={!online} onClick={() => review(true)}>
                  <Check /> Use these photos
                </Button>
              </div>
              <button
                className="text-[15px] text-muted-foreground underline"
                onClick={() => {
                  dropPreviews();
                  reset();
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {stage.k === 'step-retry' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <UserX className="size-12 text-warning" />
              <div className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">
                Step {stage.step} of 4 · {REGISTER_STEPS[stage.step - 1]}
              </div>
              <div className="font-display text-xl font-semibold">{stage.text}</div>
              {stage.step > 1 && <p className="text-muted-foreground">The pictures already taken are kept.</p>}
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="lg" variant="outline" onClick={reset}>
                  Cancel
                </Button>
                {stage.step > 1 && (
                  <Button size="lg" variant="outline" disabled={!online} onClick={() => registerScan(1)}>
                    Start over
                  </Button>
                )}
                <Button size="lg" disabled={!online} onClick={() => registerScan(stage.step)}>
                  Try this step again
                </Button>
              </div>
            </div>
          )}
          {stage.k === 'sending' && (
            <div className="flex flex-col items-center gap-3 text-center" aria-live="polite">
              <Loader2 className="size-12 animate-spin text-primary" />
              <div className="font-display text-xl font-semibold">{hint || 'Registering your face…'}</div>
            </div>
          )}
          {stage.k === 'retry' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <UserX className="size-12 text-warning" />
              {stage.text && <div className="font-display text-xl font-semibold">{stage.text}</div>}
              {stage.triesLeft !== undefined && <p className="text-muted-foreground">Tries left: {stage.triesLeft}</p>}
              <div className="flex gap-2">
                <Button size="lg" variant="outline" onClick={reset}>
                  Cancel
                </Button>
                <Button size="lg" disabled={!online} onClick={() => (!session.current ? begin() : session.current.purpose === 'REGISTER' ? registerScan(1) : scan())}>
                  Try again
                </Button>
              </div>
            </div>
          )}
          {stage.k === 'blocked' && <ManualForm text={stage.text} onSend={manual} onCancel={reset} />}
          {stage.k === 'registration-blocked' && (
            <div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center">
              <UserX className="size-12 text-warning" />
              <div className="font-display text-xl font-semibold">Registration could not be completed</div>
              <p className="text-[14px] text-muted-foreground">{stage.replacement ? 'Your current face is unchanged. You can try again while HR permission is valid.' : 'No face was registered.'} Face the light and try again, or ask your site in-charge for help.</p>
              <div className="flex gap-2">
                <Button size="lg" variant="outline" onClick={reset}>Cancel</Button>
                <Button size="lg" disabled={!online} onClick={() => begin('REGISTER', session.current?.who)}>Try registration again</Button>
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
      </main>
    </div>
  );
}

/** "Is this you?" — the existing confirmation card, with one punch button for the direction the server worked out. */
function Confirmation({ d, onConfirm, onNotMe }) {
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
      <button className="text-[15px] text-muted-foreground underline" disabled={busy} onClick={run(onNotMe)}>
        This is not me
      </button>
    </div>
  );
}

/**
 * Pick yourself from a list: type part of a name or employee ID and tap the right person.
 * `forRegister` includes first registrations and one-time HR-approved replacements.
 */
function PersonPicker({ value, onChange, forRegister, inputId }) {
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), 200);
  const found = useQuery({
    queryKey: ['tablet-people', q, !!forRegister],
    queryFn: () => api.get('/tablet/employees', { q, ...(forRegister ? { for: 'register' } : {}) }).then((r) => r.data),
    enabled: q.length >= 2 && !value,
    staleTime: forRegister ? 0 : 30_000,
    refetchInterval: forRegister ? 15_000 : false,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/50 px-3 py-2">
        <span className="min-w-0">
          <span className="block truncate text-base font-medium">{value.name}</span>
          <span className="block text-[13px] text-muted-foreground">
            {value.code}
            {value.designation ? ` · ${value.designation}` : ''}
          </span>
          {forRegister && value.allow_reregistration && <Chip tone="info" className="mt-1">HR approved</Chip>}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => { onChange(null); setText(''); }}>
          Change
        </Button>
      </div>
    );
  }
  const list = q.length >= 2 ? (found.data ?? []) : [];
  const pick = (p) => { onChange(p); setText(''); setActive(0); };
  return (
    <div className="relative">
      <Input
        id={inputId}
        role="combobox"
        aria-label="Employee name or ID"
        aria-expanded={list.length > 0}
        aria-controls={listId}
        aria-activedescendant={list[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        value={text}
        placeholder="Start typing your name or employee ID"
        autoComplete="off"
        autoCapitalize="none"
        className="h-11 text-base"
        onChange={(e) => { setText(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setActive((a) => Math.min(a + 1, list.length - 1)); }
          else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && list[active]) { e.preventDefault(); pick(list[active]); }
        }}
      />
      {q.length >= 2 && (
        <ul id={listId} role="listbox" aria-label="Matching employees" className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
          {list.map((p, i) => (
            <li id={`${listId}-${i}`} key={p.code} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-3 text-left ${i === active ? 'bg-accent' : ''}`}
              >
                <span className="min-w-0"><span className="block truncate text-base font-medium">{p.name}</span>{forRegister && p.allow_reregistration && <Chip tone="info" className="mt-1">HR approved</Chip>}</span>
                <span className="shrink-0 text-right text-[13px] text-muted-foreground">
                  {p.code}
                  {p.designation ? ` · ${p.designation}` : ''}
                </span>
              </button>
            </li>
          ))}
          {!list.length && <li className="px-3 py-3 text-[14px] text-muted-foreground">{found.isFetching ? 'Searching…' : found.isError ? errorMessage(found.error) : forRegister ? 'No active employee needing registration found. Already registered? Use Punch, or ask HR if it keeps failing.' : 'No one found. Check the spelling or ask HR.'}</li>}
        </ul>
      )}
    </div>
  );
}

function RegisterForm({ onStart, onCancel }) {
  const [who, setWho] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onStart({ employee_code: who.code, name: who.name });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="font-display text-xl font-semibold">Register face</div>
      <p className="text-[14px] text-muted-foreground">Register at any site. Already registered? HR can allow you to register again if punching keeps failing.</p>
      <Field label="Choose your name">{(id) => <PersonPicker inputId={id} value={who} onChange={setWho} forRegister />}</Field>
      {who?.allow_reregistration && <Notice>HR has approved one re-registration. Your current face is replaced only after the new photos pass the checks.</Notice>}
      <div className="rounded-md bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground">Face the light and remove anything covering your face. Follow the camera prompts; each photo is taken automatically.</div>
      <div className="flex gap-2">
        <Button variant="outline" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="flex-1" loading={busy} disabled={!who}>
          Start camera
        </Button>
      </div>
    </form>
  );
}

/** After the last try: employee ID and name go to HR as a manual request, with the face crops. */
function ManualForm({ text, onSend, onCancel }) {
  const [who, setWho] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSend(who.code, who.name);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6">
      <UserX className="size-10 text-warning" />
      <p className="font-display text-lg font-semibold">{text}</p>
      <Field label="Who are you?">{(id) => <PersonPicker inputId={id} value={who} onChange={setWho} />}</Field>
      <div className="flex gap-2">
        <Button variant="outline" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="flex-1" loading={busy} disabled={!who}>
          Send to HR
        </Button>
      </div>
    </form>
  );
}
