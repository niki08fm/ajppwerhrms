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
  const faceapi = await loadGuidance();
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return result('NO_FACE');
  const found = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }));
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

function result(code, box = null) {
  return { ok: false, code, message: messageFor(code), box };
}

/** Wait until the frame has looked right `stable` times in a row (or give up after timeoutMs). */
export async function waitForGoodFrame(video, { onHint, stable = 3, intervalMs = 150, timeoutMs = 20_000, signal } = {}) {
  const until = Date.now() + timeoutMs;
  let good = 0;
  while (Date.now() < until) {
    if (signal?.aborted) return null;
    const r = await checkFrame(video);
    onHint?.(r);
    good = r.ok ? good + 1 : 0;
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
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
