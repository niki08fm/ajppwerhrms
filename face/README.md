# face — face detection and recognition

Everything to do with faces lives here: the model files, detecting a face and turning it into numbers in the browser, and matching those numbers on the server. It is its own folder so the models can be hosted, upgraded or replaced without touching the rest of the system.

```
models/          the model files (about 7 MB), served by the backend at /face-models
  tiny_face_detector_model*       finds a face in the camera frame
  face_landmark_68_model*         locates eyes, nose and mouth to line the face up
  face_recognition_model*         turns the face into 128 numbers (the "embedding")
src/browser.ts   used by the frontend (site tablet, face enrolment): loads the models, reads the camera,
                 returns the embedding
src/match.ts     used by the backend: compares an embedding with everyone enrolled (cosine similarity)
```

## How a punch works
1. The tablet's camera sees a face. `browser.ts` finds it and turns it into 128 numbers — in the browser, on the tablet.
2. Only those numbers are sent to the backend, never a photograph (a small gate snapshot is kept for the exception queue and deleted after 30 days).
3. The backend compares them with every enrolled person (`match.ts`). At or above `FACE_MATCH_THRESHOLD` (default 0.55) the punch is recorded; below it the attempt goes to the exception queue for a person to decide.
4. When someone leaves, their enrolled numbers are deleted.

## Hosting the models
- By default the backend serves `face/models` at `/face-models`, so the tablet loads them from our own server — no outside CDN.
- To serve them from somewhere else (a separate model host or bucket), copy the `models/` folder there and set `VITE_FACE_MODEL_URL` to its address before building the frontend. To serve a different folder from the backend, set `FACE_MODELS_DIR`.

## Replacing the model
The models come from [@vladmandic/face-api](https://github.com/vladmandic/face-api) 1.7 (MIT licence). To move to another model (for example ArcFace, or add liveness detection): replace the files in `models/`, change `browser.ts` to produce the new embedding, and re-enrol everyone — embeddings from different models cannot be compared. `FACE_MODEL_VERSION` in `browser.ts` is stored with each enrolment so old and new can be told apart.
