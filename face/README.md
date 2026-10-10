# face — face v2

Face detection, recognition and the live-face check for site punches, done **on our server**:

```
service/                 the Python face service (FastAPI, CPU only) on 127.0.0.1:8100
  app/engine.py            the four models: YuNet (detect + 5 landmarks), SFace (128-number face code),
                           MiniFASNetV2 + MiniFASNetV1SE (live face, averaged)
  app/main.py              POST /analyze, GET /health; X-Face-Token; one worker, "busy" when it is taken
  app/geometry.py          head turn from the landmarks, anti-spoofing crop, picture quality
  download_models.py       fetches the models into service/models and checks their sizes (models are not in git)
  tests/                   pytest
src/                     JavaScript used by the backend (and guidance.js by the tablet)
  client.js                createFaceClient — calls the service; busy / unavailable / bad image
  decide.js                decidePunch, decideRegistration, checkDuplicate, rollingToDelete, shouldLearn
  gallery.js               buildGallery, matchGallery — only "sface-2021dec" templates are compared
  session.js               createPunchSession — tries, the head-turn challenge, identification
  messages.js              messageFor — every sentence the tablet shows
  guidance.js              browser only: Tiny Face Detector guidance and frame capture
models/                  tiny_face_detector and face_landmark_68 — the models the browser loads (served at /face-models)
deploy/ajpwer-face.service   systemd unit (700 MB memory limit, restarts itself)
INTEGRATION.md           rules, database, routes, tablet, hosting
```

## How a punch works

1. The tablet guides the person into the oval (Tiny Face Detector, in the browser). It captures one frame looking straight and one turned the way the server asked.
2. The backend sends both frames to the face service. The service finds the face (YuNet), checks it is a live face (MiniFASNet ×2), reads the head turn from the landmarks, and makes the 128-number face code (SFace). It keeps nothing.
3. The backend decides:
   - live, turned as asked, and clearly one registered person → "Is this you?" → the punch;
   - otherwise a try. After five tries, the ID and name go to HR with the face crops.
4. Face codes, not photographs, are stored. They are deleted when someone leaves.

All thresholds are in `.env` (`FACE_*`); the rules are in [INTEGRATION.md](INTEGRATION.md).

## Install (development)

```bash
npm run face:install            # python venv in face/service/.venv, packages, and the four models
# then in .env: FACE_SERVICE_DEV=1, and FACE_SERVICE_URL / FACE_SERVICE_TOKEN
npm run dev                     # backend, frontend and the face service
npm run face:check              # check authenticated health and the recognition model
npm run service:test -w @ajpwer/face
```

If the backend and frontend are already running, start the face service in another terminal with `npm run dev:face`. This explicitly starts it even when `FACE_SERVICE_DEV` is unset or `0`; `npm run dev` continues to start it automatically only when `FACE_SERVICE_DEV=1`.

If registration shows **"Face check is not working right now"**, run `npm run face:check` from the repository root. It checks the existing configuration and authenticated health without logging tokens or face data. Missing Python packages or models require `npm run face:install`; missing models in an installed environment require `npm run face:models`. Start the service with `npm run dev:face` and keep that terminal open. An authentication failure means the backend and face service need the same `FACE_SERVICE_TOKEN`; restart both after correcting their configuration.

Production: [docs/OPERATIONS.md](../docs/OPERATIONS.md) §2a.

## Replacing a model

A different recognition model makes face codes that cannot be compared with the old ones:
- change `MODEL_VERSION` in `service/app/config.py` and `src/gallery.js` together;
- keep the old templates (they are ignored);
- have everyone register again.

Licences: YuNet and SFace (OpenCV Zoo) and MiniFASNet (yakhyo/face-anti-spoofing) are Apache 2.0; the Tiny Face Detector (`@vladmandic/face-api`) is MIT.
