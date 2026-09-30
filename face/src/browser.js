let api = null;
let loading = null;

export const FACE_MODEL_VERSION = 'face-api-1.7-tiny-r128';

/** Where the model files are served from. The backend serves face/models here. */
let modelUrl = '/face-models';

/** Point the loader somewhere else (before the first load), e.g. a separate model host. */
export function configureFace(opts) {
  if (opts.modelUrl) modelUrl = opts.modelUrl.replace(/\/$/, '');
}

export function loadFaceApi() {
  if (api) return Promise.resolve(api);
  if (!loading) {
    loading = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      await faceapi.tf.ready();
      await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl), faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl), faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl)]);
      api = faceapi;
      return faceapi;
    })();
  }
  return loading;
}

/** One embedding from the current video frame, or null if no single clear face is visible. */
export async function embed(video) {
  const faceapi = await loadFaceApi();
  const det = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!det) return null;
  return { embedding: Array.from(det.descriptor), score: det.detection.score };
}

/** Average several frames for a steadier enrolment embedding. */
export async function embedAverage(video, frames = 5) {
  const got = [];
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

export function snapshot(video, width = 320) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((video.videoHeight / video.videoWidth) * width) || 240;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
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
