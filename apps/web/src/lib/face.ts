/**
 * Face embeddings in the browser with @vladmandic/face-api (loaded lazily so it
 * never weighs on the admin screens). Only the 128-number embedding leaves the
 * device — never a photograph — except a gate snapshot for the exception queue,
 * which the server deletes after 30 days.
 */
type FaceApi = typeof import('@vladmandic/face-api');

let api: FaceApi | null = null;
let loading: Promise<FaceApi> | null = null;

export const FACE_MODEL_VERSION = 'face-api-1.7-tiny-r128';
const MODEL_URL = (import.meta.env.VITE_FACE_MODEL_URL as string | undefined) || 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model';

export function loadFaceApi(): Promise<FaceApi> {
  if (api) return Promise.resolve(api);
  if (!loading) {
    loading = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      await (faceapi.tf as unknown as { ready: () => Promise<void> }).ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      api = faceapi;
      return faceapi;
    })();
  }
  return loading;
}

export interface FaceResult {
  embedding: number[];
  score: number;
}

/** One embedding from the current video frame, or null if no single clear face is visible. */
export async function embed(video: HTMLVideoElement): Promise<FaceResult | null> {
  const faceapi = await loadFaceApi();
  const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptor();
  if (!det) return null;
  return { embedding: Array.from(det.descriptor), score: det.detection.score };
}

/** Average several frames for a steadier enrolment embedding. */
export async function embedAverage(video: HTMLVideoElement, frames = 5): Promise<number[] | null> {
  const got: number[][] = [];
  for (let i = 0; i < frames * 3 && got.length < frames; i++) {
    const r = await embed(video);
    if (r) got.push(r.embedding);
    await new Promise((res) => setTimeout(res, 120));
  }
  if (got.length < Math.ceil(frames / 2)) return null;
  const avg = got[0].map((_, j) => got.reduce((s, v) => s + v[j], 0) / got.length);
  const norm = Math.sqrt(avg.reduce((s, x) => s + x * x, 0)) || 1;
  return avg.map((x) => x / norm);
}

export function snapshot(video: HTMLVideoElement, width = 320): string {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((video.videoHeight / video.videoWidth) * width) || 240;
  c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

export async function startCamera(video: HTMLVideoElement, facing: 'user' | 'environment' = 'user'): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}
