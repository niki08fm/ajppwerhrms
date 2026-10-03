import { messageFor } from './messages.js';

/**
 * Live guidance on the tablet, in the browser. Uses only the Tiny Face Detector from
 * @vladmandic/face-api to say "come closer", "one person", "more light" — it makes
 * no face codes. When the frame looks right, capture() takes a JPEG that the
 * backend sends to the face service.
 */
let modelUrl = '/face-models';
let api = null;
let loading = null;

export function configureGuidance(opts) {
  if (opts.modelUrl) modelUrl = opts.modelUrl.replace(/\/$/, '');
}

export function loadGuidance() {
  if (api) return Promise.resolve(api);
  if (!loading) {
    loading = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      await faceapi.tf.ready();
      await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
      api = faceapi;
      return faceapi;
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

let landmarksLoading = null;

/** The 68-point face outline (~350 KB) for the head angle and the eyes: used when registering. The tiny one is too rough for eyelids. */
export function loadLandmarks() {
  landmarksLoading ??= (async () => {
    const faceapi = await loadGuidance();
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl);
    return faceapi;
  })().catch((e) => {
    landmarksLoading = null;
    throw e;
  });
  return landmarksLoading;
}

// The oval on screen, as shares of the frame: centre and how big a face should be.
const OVAL = { cx: 0.5, cy: 0.45, maxOffset: 0.18 };
const FACE_WIDTH = { min: 0.22, max: 0.62 };
const LIGHT = { min: 55, max: 215 };

let probe = null;
function brightness(video, box) {
  probe ??= document.createElement('canvas');
  probe.width = 32;
  probe.height = 32;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4);
}

/**
 * One look at the current frame. Returns { ok, code, message, box } where code is
 * NO_FACE, MULTIPLE_FACES, TOO_FAR, TOO_CLOSE, OFF_CENTRE, TOO_DARK, TOO_BRIGHT or OK.
 */
export async function checkFrame(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return result('NO_FACE');
  const found = await findFaces(video);
  if (found.length === 0) return result('NO_FACE');
  if (found.length > 1) return result('MULTIPLE_FACES');
  const box = found[0].box;
  const share = box.width / w;
  if (share < FACE_WIDTH.min) return result('TOO_FAR', box);
  if (share > FACE_WIDTH.max) return result('TOO_CLOSE', box);
  const dx = (box.x + box.width / 2) / w - OVAL.cx;
  const dy = (box.y + box.height / 2) / h - OVAL.cy;
  if (Math.hypot(dx, dy) > OVAL.maxOffset) return result('OFF_CENTRE', box);
  const light = brightness(video, box);
  if (light < LIGHT.min) return result('TOO_DARK', box);
  if (light > LIGHT.max) return result('TOO_BRIGHT', box);
  return { ok: true, code: 'OK', message: messageFor('HOLD_STILL'), box };
}

/** Is this face box well placed: size, centre, light? An error code, or null when it is. */
function placement(video, box) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const share = box.width / w;
  if (share < FACE_WIDTH.min) return 'TOO_FAR';
  if (share > FACE_WIDTH.max) return 'TOO_CLOSE';
  if (Math.hypot((box.x + box.width / 2) / w - OVAL.cx, (box.y + box.height / 2) / h - OVAL.cy) > OVAL.maxOffset) return 'OFF_CENTRE';
  const light = brightness(video, box);
  if (light < LIGHT.min) return 'TOO_DARK';
  if (light > LIGHT.max) return 'TOO_BRIGHT';
  return null;
}

// Depth of the nose tip in front of the eyes, as a share of the eye distance: the face service's figure.
const NOSE_DEPTH_RATIO = 0.55;
const mean = (pts) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Head turn in degrees, measured as the face service measures it: positive when the person
 * turns to their own left (in the unmirrored camera frame the nose moves to the right).
 */
function yawOf(pts) {
  const eyeA = mean(pts.slice(36, 42));
  const eyeB = mean(pts.slice(42, 48));
  const d = dist(eyeA, eyeB);
  if (d < 1e-6) return 0;
  const ratio = (pts[30].x - (eyeA.x + eyeB.x) / 2) / d;
  return (Math.atan(ratio / NOSE_DEPTH_RATIO) * 180) / Math.PI;
}

/** How open the eyes are (eye aspect ratio): about 0.3 when open, falling towards 0.1 when closed. */
function eyesOpen(pts) {
  const one = (o) => (dist(pts[o + 1], pts[o + 5]) + dist(pts[o + 2], pts[o + 4])) / (2 * dist(pts[o], pts[o + 3]));
  return (one(36) + one(42)) / 2;
}

/** One look with the face outline: { count } and, for exactly one face, its box, head turn and eye openness. */
export async function readFace(video) {
  const faceapi = await loadLandmarks();
  if (!video.videoWidth) return { count: 0 };
  const found = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })).withFaceLandmarks();
  if (found.length !== 1) return { count: found.length };
  const pts = found[0].landmarks.positions;
  return { count: 1, box: found[0].detection.box, yaw: yawOf(pts), eyes: eyesOpen(pts) };
}

const pause = (ms) => new Promise((res) => setTimeout(res, ms));
const noFace = (r) => result(r.count ? 'MULTIPLE_FACES' : 'NO_FACE');

/**
 * Registration step 1: one face, well placed and lit, looking at the camera (head turned no
 * more than maxYaw), held for `stable` looks in a row. Returns { box, yaw }, or null.
 */
export async function waitForStraight(video, { onHint, onProgress, maxYaw = 12, stable = 10, intervalMs = 120, timeoutMs = 30_000, signal } = {}) {
  const until = Date.now() + timeoutMs;
  let good = 0;
  while (Date.now() < until) {
    if (signal?.aborted) return null;
    const r = await readFace(video);
    let hint;
    if (r.count !== 1) hint = noFace(r);
    else {
      const p = placement(video, r.box);
      hint = p ? result(p, r.box) : Math.abs(r.yaw) > maxYaw ? result('LOOK_AT_CAMERA', r.box) : { ok: true, code: 'OK', message: messageFor('HOLD_STILL'), box: r.box };
    }
    onHint?.(hint);
    good = hint.ok ? good + 1 : 0;
    onProgress?.(Math.min(1, good / stable));
    if (good >= stable) return { box: r.box, yaw: r.yaw };
    await pause(intervalMs);
  }
  return null;
}

/**
 * Registration steps 2 and 3: turn to the person's own LEFT or RIGHT by at least minDeg from
 * the straight picture (the server asks for 15°), then hold still. Turning the other way says so.
 * Returns { yaw }, or null.
 */
export async function waitForHeadTurn(video, { fromYaw, direction, onHint, onProgress, minDeg = 20, intervalMs = 120, timeoutMs = 30_000, signal } = {}) {
  const sign = direction === 'LEFT' ? 1 : -1;
  const ask = messageFor(direction === 'LEFT' ? 'TURN_LEFT' : 'TURN_RIGHT');
  const until = Date.now() + timeoutMs;
  let last = null;
  let still = 0;
  while (Date.now() < until) {
    if (signal?.aborted) return null;
    const r = await readFace(video);
    if (r.count !== 1) {
      onHint?.(noFace(r));
      [last, still] = [null, 0];
    } else {
      const turned = (r.yaw - fromYaw) * sign;
      onProgress?.(Math.max(0, Math.min(1, turned / minDeg)));
      if (turned >= minDeg) {
        still = last !== null && Math.abs(r.yaw - last) < 4 ? still + 1 : 0;
        onHint?.({ ok: true, code: 'HOLD_STILL', message: messageFor('HOLD_STILL') });
        if (still >= 2) return { yaw: r.yaw };
      } else {
        still = 0;
        const code = turned <= -10 ? (direction === 'LEFT' ? 'TURN_OTHER_WAY_LEFT' : 'TURN_OTHER_WAY_RIGHT') : turned >= minDeg / 2 ? 'TURN_MORE' : null;
        onHint?.({ ok: false, code: code ?? 'TURN', message: code ? messageFor(code) : ask });
      }
      last = r.yaw;
    }
    await pause(intervalMs);
  }
  return null;
}

/**
 * Registration step 4: eyes open, then closed for a moment, then open again, facing the
 * camera. The check looks a few times a second and a quick blink is shorter than that, so
 * the person is asked to keep their eyes closed for a moment: it counts when the eyes are
 * seen closed twice in a row, and the picture is taken then. Eye openness is compared with
 * this person's own open eyes. After `slowMs` without it, `onSlow()` fires so the screen can
 * offer to take the picture anyway; `skip.requested = true` does that. Returns { blob }, or null.
 */
export async function waitForBlink(video, { fromYaw = 0, onHint, onProgress, onSlow, skip, slowMs = 10_000, intervalMs = 40, timeoutMs = 60_000, signal } = {}) {
  const started = Date.now();
  const until = started + timeoutMs;
  let baseline = 0; // how open this person's eyes are
  let seen = 0;
  let shortOfBaseline = 0;
  let closed = null;
  let slow = false;
  while (Date.now() < until) {
    if (signal?.aborted) return null;
    if (skip?.requested) return { blob: closed ?? (await capture(video)), manual: true };
    if (!slow && Date.now() - started > slowMs) {
      slow = true;
      onSlow?.();
    }
    const r = await readFace(video);
    if (r.count !== 1) onHint?.(noFace(r));
    else if (Math.abs(r.yaw - fromYaw) > 15) onHint?.(result('LOOK_AT_CAMERA', r.box));
    else if (!closed) {
      // Open eyes set the baseline; readings far below it are closed eyes and never lower it.
      if (baseline === 0 || r.eyes >= baseline * 0.85) baseline = baseline === 0 ? r.eyes : Math.max(baseline * 0.995, r.eyes);
      seen++;
      shortOfBaseline = seen >= 5 && r.eyes < baseline * 0.72 ? shortOfBaseline + 1 : 0;
      onProgress?.(Math.min(0.5, shortOfBaseline / 4));
      if (shortOfBaseline >= 2) {
        closed = await capture(video);
        onProgress?.(0.6);
        onHint?.({ ok: true, code: 'BLINK_OPEN', message: messageFor('BLINK_OPEN') });
      } else onHint?.({ ok: false, code: 'BLINK', message: messageFor('BLINK') });
    } else if (r.eyes > baseline * 0.82) {
      onProgress?.(1);
      return { blob: closed };
    }
    await pause(intervalMs);
  }
  return null;
}

async function findFaces(video) {
  const faceapi = await loadGuidance();
  return faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }));
}

function result(code, box = null) {
  return { ok: false, code, message: messageFor(code), box };
}

/**
 * Wait until the frame has looked right `stable` times in a row (or give up after timeoutMs).
 * `onProgress(0…1)` says how far through holding steady the person is; it falls back to 0
 * whenever the frame stops looking right, so they see they must stay put.
 */
export async function waitForGoodFrame(video, { onHint, onProgress, stable = 3, intervalMs = 150, timeoutMs = 20_000, signal } = {}) {
  const until = Date.now() + timeoutMs;
  let good = 0;
  while (Date.now() < until) {
    if (signal?.aborted) return null;
    const r = await checkFrame(video);
    onHint?.(r);
    good = r.ok ? good + 1 : 0;
    onProgress?.(Math.min(1, good / stable));
    if (good >= stable) return r;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return null;
}

/** The current frame as a JPEG Blob (unmirrored, at most maxWidth wide). */
export function capture(video, { maxWidth = 640, quality = 0.9 } = {}) {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture the camera frame.'))), 'image/jpeg', quality));
}

export async function startCamera(video, facing = 'user') {
  // A phone held upright gets an upright picture, so the face fills the screen instead of being cropped.
  const upright = window.innerHeight > window.innerWidth;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: upright ? 480 : 640 }, height: { ideal: upright ? 640 : 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
