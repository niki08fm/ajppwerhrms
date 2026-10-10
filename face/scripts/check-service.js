/** Checks the configured service without logging credentials or face data. */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFaceClient, FaceServiceBusy } from '../src/client.js';
import { MODEL_VERSION } from '../src/gallery.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const envFile = path.join(root, '.env');
const fail = (message, recovery) => {
  console.error(`[face] ${message}`);
  if (recovery) console.error(`[face] ${recovery}`);
  process.exitCode = 1;
};

function localSetupHint() {
  const configured = process.env.FACE_SERVICE_MODELS_DIR;
  const models = configured ? path.resolve(root, 'face/service', configured) : path.join(root, 'face/service/models');
  const filenames = ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx', 'MiniFASNetV2.onnx', 'MiniFASNetV1SE.onnx'];
  const present = (name) => {
    try { return statSync(path.join(models, name)).isFile(); } catch { return false; }
  };
  const missing = filenames.filter((name) => !present(name)).length;
  const installed = existsSync(path.join(root, 'face/service/.venv/bin/python'));
  if (!installed) return 'Install the local Python environment and models with npm run face:install, then run npm run dev:face in another terminal.';
  if (missing) return `Local face models are missing (${missing} of 4). Run npm run face:models, then npm run dev:face in another terminal.`;
  return 'Run npm run dev:face in another terminal and check its startup output. Confirm FACE_SERVICE_URL and FACE_SERVICE_PORT refer to the same service.';
}

async function check() {
  try {
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  } catch {
    fail('Could not read the root .env file.', 'Check its syntax and read permissions, then run npm run face:check again.');
    return;
  }

  const url = process.env.FACE_SERVICE_URL?.trim();
  const token = process.env.FACE_SERVICE_TOKEN;
  if (!url || !token) {
    fail('FACE_SERVICE_URL and FACE_SERVICE_TOKEN must both be configured.', 'Set them in the root .env or process environment. The backend and face service must use the same token.');
    return;
  }
  let parsed;
  try { parsed = new URL(url); } catch { /* report without exposing the configured value */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('FACE_SERVICE_URL must be an HTTP(S) service URL without credentials, query parameters or a fragment.', 'Correct the root .env setting, then run npm run face:check again.');
    return;
  }
  if (token.trim().length < 24) {
    fail('FACE_SERVICE_TOKEN must contain at least 24 characters.', 'Use the same configured token for the backend and face service, then restart both.');
    return;
  }
  const timeoutMs = Number(process.env.FACE_SERVICE_TIMEOUT_MS ?? 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    fail('FACE_SERVICE_TIMEOUT_MS must be an integer of at least 1000 milliseconds.', 'Remove the optional setting to use the 8000 millisecond default, or correct it.');
    return;
  }

  try {
    const health = await createFaceClient({ url, token, timeoutMs }).health();
    if (health?.ok !== true) {
      fail('The face service did not report that it is ready.', 'Check its startup output and installed models, then retry npm run face:check.');
      return;
    }
    if (health.model_version !== MODEL_VERSION) {
      fail('The face service model does not match this checkout.', 'Start the service from this checkout with npm run dev:face, or update the deployed service and backend together.');
      return;
    }
    console.log(`[face] Healthy. Recognition model ${MODEL_VERSION} is ready${health.busy ? '; currently processing a request' : ''}.`);
  } catch (error) {
    if (/^The face service answered (401|403)\b/.test(error?.message ?? '')) {
      fail('The face service rejected authentication.', 'Ensure FACE_SERVICE_TOKEN has the same value in the backend and service environments, then restart both.');
    } else if (error instanceof FaceServiceBusy) {
      fail('The face service is busy or did not answer before the timeout.', 'Retry npm run face:check. If this continues, check the service process and its startup output.');
    } else {
      const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
      fail('The configured face service could not be reached or returned an invalid response.', local ? localSetupHint() : 'Start the configured face service and check network access and service logs, then retry npm run face:check.');
    }
  }
}

await check();
