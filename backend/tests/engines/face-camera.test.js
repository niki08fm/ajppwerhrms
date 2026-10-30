import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCamera, stopCamera } from '@ajpwer/face/guidance';

afterEach(() => vi.unstubAllGlobals());

function camera({ portrait = true, play = vi.fn().mockResolvedValue(undefined), tracks } = {}) {
  const ownedTracks = tracks ?? [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => ownedTracks };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('window', { innerHeight: portrait ? 900 : 600, innerWidth: portrait ? 600 : 900 });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { stream, tracks: ownedTracks, getUserMedia, video: { srcObject: null, play } };
}

describe('camera startup and release', () => {
  it('returns an owned playing stream with portrait constraints and no audio', async () => {
    const c = camera();
    await expect(startCamera(c.video)).resolves.toBe(c.stream);
    expect(c.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 640 } }, audio: false,
    });
    expect(c.video.srcObject).toBe(c.stream);
    expect(c.video.play).toHaveBeenCalledOnce();
    for (const track of c.tracks) expect(track.stop).not.toHaveBeenCalled();
  });

  it('retains the requested facing mode and landscape constraints', async () => {
    const c = camera({ portrait: false });
    await startCamera(c.video, 'environment');
    expect(c.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
  });

  it('propagates permission rejection without attempting playback', async () => {
    const c = camera();
    const error = Object.assign(new Error('Camera access denied'), { name: 'NotAllowedError' });
    c.getUserMedia.mockRejectedValue(error);
    await expect(startCamera(c.video)).rejects.toBe(error);
    expect(c.video.play).not.toHaveBeenCalled();
    expect(c.video.srcObject).toBeNull();
  });

  it('releases every captured track and clears the element when playback rejects', async () => {
    const error = Object.assign(new Error('Playback blocked'), { name: 'NotAllowedError' });
    const c = camera({ play: vi.fn().mockRejectedValue(error) });
    await expect(startCamera(c.video)).rejects.toBe(error);
    for (const track of c.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(c.video.srcObject).toBeNull();
  });

  it('releases a captured stream when attaching it to the video element fails', async () => {
    const c = camera();
    const error = new Error('Video element unavailable');
    Object.defineProperty(c.video, 'srcObject', { get: () => null, set: () => { throw error; } });
    await expect(startCamera(c.video)).rejects.toBe(error);
    for (const track of c.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(c.video.play).not.toHaveBeenCalled();
  });

  it('does not detach a newer stream when an older playback attempt fails', async () => {
    const error = new Error('Earlier attempt stopped');
    let rejectPlay;
    const c = camera({ play: vi.fn().mockImplementation(() => new Promise((resolve, reject) => { rejectPlay = reject; })) });
    const pending = startCamera(c.video);
    await vi.waitFor(() => expect(c.video.play).toHaveBeenCalledOnce());
    const newerStream = { getTracks: () => [{ stop: vi.fn() }] };
    c.video.srcObject = newerStream;
    rejectPlay(error);
    await expect(pending).rejects.toBe(error);
    expect(c.video.srcObject).toBe(newerStream);
    for (const track of c.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('never attaches a cancelled permission request over a newer active camera', async () => {
    const c = camera();
    let resolveOld;
    let current = true;
    c.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const cancelled = startCamera(c.video, 'user', { isCurrent: () => current });
    current = false;
    const newerTracks = [{ stop: vi.fn() }];
    const newerStream = { getTracks: () => newerTracks };
    c.getUserMedia.mockResolvedValueOnce(newerStream);
    await expect(startCamera(c.video)).resolves.toBe(newerStream);
    expect(c.video.srcObject).toBe(newerStream);
    resolveOld(c.stream);
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.video.srcObject).toBe(newerStream);
    expect(c.video.play).toHaveBeenCalledOnce();
    for (const track of c.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of newerTracks) expect(track.stop).not.toHaveBeenCalled();
  });

  it('keeps the original startup error and releases other tracks if one stop fails', async () => {
    const error = new Error('Playback failed');
    const tracks = [{ stop: vi.fn(() => { throw new Error('Device disconnected'); }) }, { stop: vi.fn() }];
    const c = camera({ play: vi.fn().mockRejectedValue(error), tracks });
    await expect(startCamera(c.video)).rejects.toBe(error);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(c.video.srcObject).toBeNull();
  });

  it('can release an absent stream safely', () => {
    expect(() => stopCamera(null)).not.toThrow();
    expect(() => stopCamera(undefined)).not.toThrow();
  });
});
