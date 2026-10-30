import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ frames: [], reads: 0, captures: 0, light: 120, onRead: null }));
vi.mock('@vladmandic/face-api', () => {
  const detect = () => {
    const r = probe.frames[Math.min(probe.reads++, probe.frames.length - 1)] ?? {};
    probe.light = r.light ?? 120;
    probe.onRead?.();
    const count = r.count ?? 1;
    const points = Array.from({ length: 68 }, () => ({ x: 320, y: 200 }));
    for (const [offset, cx] of [[36, 260], [42, 380]]) {
      const h = (r.eyes ?? 0.3) * 10;
      const eye = [[-10, 0], [-5, -h], [5, -h], [10, 0], [5, h], [-5, h]];
      eye.forEach(([x, y], i) => { points[offset + i] = { x: cx + x, y: 200 + y }; });
    }
    points[30] = { x: 320 + Math.tan((r.yaw ?? 0) * Math.PI / 180) * 0.55 * 120, y: 220 };
    const faces = Array.from({ length: count }, () => ({ box: { x: 200, y: 110, width: 240, height: 210 } }));
    const promise = Promise.resolve(faces);
    promise.withFaceLandmarks = async () => faces.map((detection) => ({ detection, landmarks: { positions: points } }));
    return promise;
  };
  return {
    tf: { ready: async () => {} },
    nets: { tinyFaceDetector: { loadFromUri: async () => {} }, faceLandmark68Net: { loadFromUri: async () => {} } },
    TinyFaceDetectorOptions: class {},
    detectAllFaces: detect,
  };
});

import { loadLandmarks, waitForBlink, waitForGoodFrame, waitForHeadTurn, waitForStraight } from '@ajpwer/face/guidance';
beforeAll(async () => { await loadLandmarks(); });
const video = { videoWidth: 640, videoHeight: 480 };
const finish = async (promise) => {
  await vi.runAllTimersAsync();
  return promise;
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(probe, { frames: [], reads: 0, captures: 0, light: 120, onRead: null });
  vi.stubGlobal('document', { createElement: () => ({
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([probe.light, probe.light, probe.light, 255]) }) }),
    toBlob: (cb) => { probe.captures++; cb(new Blob(['photo'], { type: 'image/jpeg' })); },
  }) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Comfortable browser capture, with server verification unchanged', () => {
  it('keeps hold progress through one brief detector dropout', async () => {
    probe.frames = [{}, {}, { count: 0 }, {}, {}];
    const progress = [];
    expect(await finish(waitForStraight(video, { onProgress: (p) => progress.push(p) }))).toBeTruthy();
    expect(probe.reads).toBe(5);
    expect(progress[2]).toBe(progress[1]);
  });

  it('resets hold progress when another person enters the picture', async () => {
    probe.frames = [{}, {}, { count: 2 }, {}, {}, {}, {}];
    const progress = [];
    expect(await finish(waitForStraight(video, { onProgress: (p) => progress.push(p) }))).toBeTruthy();
    expect(probe.reads).toBe(7);
    expect(progress[2]).toBe(0);
  });

  it('does not finish a punch frame hold in poor lighting', async () => {
    probe.frames = [{}, {}, { light: 20 }];
    expect(await finish(waitForGoodFrame(video, { timeoutMs: 1000 }))).toBeNull();
    expect(probe.captures).toBe(0);
  });

  it('resets punch progress after a sustained lost face', async () => {
    probe.frames = [{}, { count: 0 }, { count: 0 }, { count: 0 }, {}, {}, {}];
    const progress = [];
    expect(await finish(waitForGoodFrame(video, { onProgress: (p) => progress.push(p) }))).toBeTruthy();
    expect(progress[3]).toBe(0);
    expect(probe.reads).toBe(7);
  });

  it.each([['LEFT', 1], ['RIGHT', -1]])('accepts a small held %s turn without requiring a bigger turn', async (direction, sign) => {
    probe.frames = [{ yaw: sign * 16.5 }, { yaw: sign * 17.5 }, { yaw: sign * 18 }];
    const result = await finish(waitForHeadTurn(video, { fromYaw: 0, direction }));
    expect(result.yaw).toBeCloseTo(sign * 18);
    expect(probe.reads).toBe(3);
  });

  it('does not accept turning in the wrong direction', async () => {
    probe.frames = [{ yaw: -25 }];
    expect(await finish(waitForHeadTurn(video, { fromYaw: 0, direction: 'LEFT', timeoutMs: 500 }))).toBeNull();
  });

  it('recognises a single closed-eye reading after calibration and reopening', async () => {
    probe.frames = [{}, {}, {}, { eyes: 0.1 }, {}];
    const hints = [];
    const result = await finish(waitForBlink(video, { onHint: (r) => hints.push(r.code) }));
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.manual).toBeUndefined();
    expect(probe.captures).toBe(1);
    expect(probe.reads).toBe(5);
    expect(hints).toContain('BLINK_READY');
    expect(hints).toContain('BLINK_OPEN');
  });

  it('cannot learn already-closed eyes as the open-eye baseline', async () => {
    probe.frames = [{ eyes: 0.1 }];
    expect(await finish(waitForBlink(video, { timeoutMs: 300 }))).toBeNull();
    expect(probe.captures).toBe(0);
  });

  it('requires reopening eyes after the closed photo', async () => {
    probe.frames = [{}, {}, {}, { eyes: 0.1 }];
    expect(await finish(waitForBlink(video, { timeoutMs: 300 }))).toBeNull();
    expect(probe.captures).toBe(1);
  });

  it('offers fallback sooner but never captures an empty frame', async () => {
    probe.frames = [{ count: 0 }, { count: 0 }, { count: 0 }, {}];
    const slow = vi.fn();
    const result = await finish(waitForBlink(video, { skip: { requested: true }, slowMs: 80, onSlow: slow }));
    expect(result.manual).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(probe.reads).toBe(4);
    expect(probe.captures).toBe(1);
  });

  it('does not let fallback bypass the single face requirement', async () => {
    probe.frames = [{ count: 2 }];
    expect(await finish(waitForBlink(video, { skip: { requested: true }, slowMs: 0, timeoutMs: 300 }))).toBeNull();
    expect(probe.captures).toBe(0);
  });

  it('does not complete an obsolete capture after detection resolves', async () => {
    const controller = new AbortController();
    probe.onRead = () => controller.abort();
    expect(await finish(waitForBlink(video, { signal: controller.signal }))).toBeNull();
    expect(probe.captures).toBe(0);
  });
});

// Browser comfort changes must still satisfy the existing server requirements.
import { buildGallery, decideGuidedRegistration } from '@ajpwer/face';
describe('Server verification of comfortable registration poses', () => {
  const gallery = buildGallery([]);
  const analysis = (yaws = [0, 17, -17, 0], score = 0.9) => ({ frames: yaws.map((yaw) => ({
    faces: 1, yaw, live: { score }, embedding: [1, ...Array(127).fill(0)],
    quality: { brightness: 120, sharpness: 100, face_px: 150 },
  })) });
  it('accepts a valid small turn in both directions', () => {
    expect(decideGuidedRegistration({ analysis: analysis(), gallery, employeeId: 'a' }).outcome).toBe('REGISTERED');
  });
  it('continues to reject an insufficient turn', () => {
    expect(decideGuidedRegistration({ analysis: analysis([0, 10, -17, 0]), gallery, employeeId: 'a' }).code).toBe('TURN_LEFT_NOT_SEEN');
  });
  it('continues to reject failed liveness', () => {
    expect(decideGuidedRegistration({ analysis: analysis(undefined, 0), gallery, employeeId: 'a' }).outcome).toBe('NOT_LIVE');
  });
  it('continues to reject a fourth photo containing another person', () => {
    const input = analysis();
    input.frames[3].embedding = [0, 1, ...Array(126).fill(0)];
    expect(decideGuidedRegistration({ analysis: input, gallery, employeeId: 'a' }).code).toBe('NOT_SAME_PERSON');
  });
});
