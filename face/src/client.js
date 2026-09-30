/**
 * The backend's client for the Python face service (127.0.0.1:8100). Sends the
 * frames with X-Face-Token and a request id. "Busy" (and a timeout, which the
 * service may still be working through) is its own error: the tablet retries the
 * same upload, and it never counts as a failed try.
 */
export class FaceServiceBusy extends Error {
  constructor(message = 'The face service is busy.') {
    super(message);
    this.name = 'FaceServiceBusy';
  }
}

export class FaceServiceUnavailable extends Error {
  constructor(message = 'The face service is not reachable.') {
    super(message);
    this.name = 'FaceServiceUnavailable';
  }
}

export class FaceServiceBadImage extends Error {
  constructor(message = 'A frame is not a readable image.') {
    super(message);
    this.name = 'FaceServiceBadImage';
  }
}

export function createFaceClient({ url, token, timeoutMs = 8000, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  const base = url.replace(/\/$/, '');
  const headers = { 'X-Face-Token': token };

  async function call(path, init) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new FaceServiceBusy('The face service did not answer in time.');
      throw new FaceServiceUnavailable();
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    if (res.status === 503 || res.status === 429) throw new FaceServiceBusy();
    if (res.status === 422 && body?.error === 'bad_image') throw new FaceServiceBadImage(body.message);
    if (!res.ok) throw new FaceServiceUnavailable(`The face service answered ${res.status}${body?.message ? `: ${body.message}` : ''}.`);
    return body;
  }

  return {
    /** frames: Buffers/Uint8Arrays of JPEG. Returns { model_version, frames: [...], ms }. */
    analyze(frames, { requestId }) {
      const form = new FormData();
      form.set('request_id', requestId);
      frames.forEach((f, i) => form.append('frames', new Blob([f], { type: 'image/jpeg' }), `frame${i}.jpg`));
      return call('/analyze', { method: 'POST', body: form });
    },
    health() {
      return call('/health', { method: 'GET' });
    },
  };
}
