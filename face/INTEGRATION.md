# Face v2 — integration

How face v2 fits into AJPWER Workforce: the rules, the database, the routes, the tablet, and hosting. The code that implements each section is named in it.

---

## 1. Rules

**Who decides.** The backend owns every decision and all data: templates, the gallery cache, tries, challenges, confirm tokens, punches, face exceptions and the attempt log. The Python face service only analyses frames. The browser only guides and captures. HR's decision is final everywhere.

**The models** (server, CPU only, all Apache 2.0):

| # | Model | File | Used for |
| --- | --- | --- | --- |
| 1 | YuNet (OpenCV Zoo) via `cv2.FaceDetectorYN` | `face_detection_yunet_2023mar.onnx` | Finding the face and its 5 landmarks; the landmarks give the head turn |
| 2 | SFace (OpenCV Zoo) via `cv2.FaceRecognizerSF` | `face_recognition_sface_2021dec.onnx` | `alignCrop` to 112×112, then `feature`: 128 numbers, normalised to length 1. Similarity = dot product. Stored as model version `sface-2021dec` |
| 3 | MiniFASNetV2 (Silent-Face, ONNX export by yakhyo/face-anti-spoofing), onnxruntime | `MiniFASNetV2.onnx` | Live-face check: face crop grown 2.7×, 80×80 BGR, class 1 = real |
| 4 | MiniFASNetV1SE, same source | `MiniFASNetV1SE.onnx` | Live-face check, crop grown 4.0× |

The live-face score is the average of 3 and 4. In the browser, only the Tiny Face Detector from `@vladmandic/face-api` runs, for guidance (face in the oval, distance, one person, light). No face codes are made in the browser.

**A punch** is a *session* at one tablet:

1. The tablet starts a session. The server answers with its time window (`FACE_CHALLENGE_SECONDS`). A punch has no head turn.
2. The tablet waits for a good frame (guidance), then captures three pictures looking straight, a third of a second apart, and uploads them (`front`, `front2`, `front3`) with a `request_id` it chose.
3. The server sends the three frames to the face service and decides (`decidePunch`, face/src/decide.js):
   - Not tries (the tablet should have caught them): no face, several faces, poor light, too small, blurred. Also "busy" and "face service down".
   - Tries: not a live face (the middle of the three camera scores must reach `FACE_LIVE_MIN`; with no head turn this is the whole check that it is not a photo), the three pictures not one person (`FACE_SAME_PERSON_MIN`), no match. The three face codes are averaged before matching.
   - Identified: the best person scores at least `FACE_MATCH_MIN` *and* beats the next person by `FACE_MATCH_MARGIN`.
4. **Identified** → the confirmation screen: "Is this you?", the name, and one button for the direction the server worked out (IN, or OUT while an IN from the same shift, 16 h, is open at this site). The tablet can also choose **"This is not me"** (a try). Confirming writes the punch. An open IN at another site must be closed there first. The confirm token expires after `FACE_CONFIRM_SECONDS`; after that the person scans again, and it does not count as a try.
5. After `FACE_MAX_TRIES` failed tries (default 5) the session is **blocked**. The tablet shows the ID and name form. It becomes a manual request (a face exception of kind `FAILED_TRIES`) with the aligned face crops of the failed tries. Nothing is marked present until HR decides.

**Duplicates** (`checkDuplicate`). Any punch within 2 minutes of the person's last one is a repeat and is not written (a second scan by accident). An IN while an IN from the same shift is open is refused. For travel to another site, request the transfer separately, then punch OUT at the source and IN at the destination.

**Busy.** A "busy" reply from the face service (HTTP 503, or no answer within `FACE_SERVICE_TIMEOUT_MS`) is never a failed try. The tablet sends the same upload again with the same `request_id`.

**The same `request_id` never punches twice.** Each analysed upload is stored under (session, request_id) with the reply it got. A retry gets the same reply. If it was an identification still waiting, the retry gets a fresh confirm token and the old one stops working. Confirming a session that already punched returns the same punch. There is also at most one punch per session (unique `punch.session_id`).

**Registration.** Face registration is separate from onboarding and never blocks activation. Once **ACTIVE**, employees can register at any site: **Register face** on the tablet takes their employee ID and name, then guides live captures. Registration does not create an attendance punch. Employees have no permanent site assignment; their latest punch determines current presence. Old `faceapi-v1` templates remain stored but are never matched (`buildGallery` ignores them). Registration is refused when:
- the employee is not active,
- the person already has a face v2 template and has no usable HR re-registration authorization, or
- the face is already registered to someone else (`FACE_DUPLICATE_MIN`).

Until they register, their scans do not match, and after the tries they go through the manual request.

**HR-authorized re-registration.** On the employee's Overview → Face punch card, HR with `people.write` can allow one replacement and record a reason. The authorization expires after seven days and can be revoked before use. The employee uses the existing **Register face** button at any site; its picker includes employees with a usable authorization. A registration session is bound to that specific authorization when it starts. Expiry, revocation, failed captures or a face already belonging to another employee preserve existing templates. Successful registration atomically replaces registered and rolling templates and consumes the authorization. Retrying the completed upload returns the saved reply without replacing again or creating attendance.

The card suggests review after at least four consecutive calendar work dates with HR-approved `FAILED_TRIES` exceptions linked to actual `EXCEPTION` punches. Duplicate failures on one work date count once; pending/rejected exceptions and free manual attendance entries do not count. A successful face punch or a gap breaks the sequence, and stale sequences are not flagged. This is a suggestion, not automatic permission: HR may authorize a replacement sooner.

Profile cameras remain unavailable; the old profile upload endpoint returns `409 FACE_REGISTRATION_AT_SITE` and never replaces a template. Historical FACE onboarding rows are retained but excluded from the current checklist. HR authorization, cancellation and successful replacement are audited without logging embeddings.

**Rolling templates.** A confirmed punch that was sure (`FACE_LEARN_MIN`) and live adds its face code as a *rolling* template. Each person keeps at most `FACE_ROLLING_MAX` rolling templates, the oldest dropped first (`rollingToDelete`). Registered templates are never dropped.

**Change site and travel.** When punching out, **Change site** asks where the person is going, punches OUT here and records a site change.
- The travel time counts only if they punch IN at the named site the same day: the minutes from OUT to IN, capped at `FACE_TRAVEL_MAX_MIN`. Punching in anywhere else, or on a later day, means it does not count.
- HR sees every change under **Approvals → Site changes** and can set any figure, which is final.
- Counted travel is worked time in the day (`computeDay`, `travel_min`). It comes out of the break between the two sites.

**No network.** Offline punching is not possible. The tablet shows "No network. Punch is not possible right now. Tell your site in-charge." and HR enters the day manually (Attendance → manual punch).

**Privacy.**
- Face codes are stored, never photographs.
- The face service keeps nothing.
- The aligned 112×112 crops of failed tries are kept only for a manual request, and deleted with the gate snapshots after 30 days. When a session ends any other way, its crops are deleted at once.
- The attempt log holds scores and angles, never images or face codes.

## 2. Database

Migration `backend/prisma/migrations/20261003090000_face_v2`:

| Table | Change |
| --- | --- |
| `employee_face` | `kind` (REGISTERED, ROLLING), `site_id`, `score`, `live_score`. Every existing row gets `model_version = 'faceapi-v1'`. |
| `punch` | `session_id`, unique: at most one punch per session. |
| `face_exception` | `kind` (NOT_RECOGNISED, FAILED_TRIES), `crop_keys`, `claimed_name`, `session_id`. |
| `punch_session` *(new)* | One attempt at a tablet: purpose (PUNCH, REGISTER), status (ACTIVE, IDENTIFIED, BLOCKED, DONE), tries, the session `state` (challenge, identification, failures — from `createPunchSession`), crop keys, the punch or exception it ended in. |
| `punch_attempt` *(new)* | Every analysed upload and every "This is not me": outcome, whether it was a try, best and second score, live score, both head angles, the challenge, picture quality, service time, what happened after (CONFIRMED, NOT_ME, CHANGED_SITE, EXPIRED), and the reply (for retries). Unique on (session, request_id). |
| `site_change` *(new)* | Change site: from, to, the OUT punch, the IN punch, travel minutes, status (PENDING, COUNTED, NOT_COUNTED), HR's figure and who set it. |

Retention (nightly job):
- crops go with the gate snapshots after 30 days;
- pending site changes from earlier days become NOT_COUNTED;
- attempts older than `RETENTION_PUNCH_ATTEMPT_DAYS` (365) are deleted.

## 3. Routes

All under `/api/v1`. Tablet routes need the site session; punch and registration writes re-check the geofence. Workspace reads are scoped to the authenticated site. Code: `backend/src/routes/tablet.routes.js`, `backend/src/controllers/tablet.controller.js`, `backend/src/controllers/site-workspace.controller.js`.

| Route | Who | Does |
| --- | --- | --- |
| `POST /punches/sessions` | tablet | Start a punch (`purpose: PUNCH`) or a registration (`purpose: REGISTER`, `employee_code`, `name`). Returns the challenge. |
| `POST /punches/sessions/:id/frames` | tablet | Multipart: a punch sends `front`, `front2`, `front3`; a registration sends `front`, `left`, `right`, `blink` (JPEG), `request_id`, `lat`, `lng`, `accuracy_m`. Returns the decision. 503 `FACE_BUSY`: send the same upload again. |
| `POST /punches/sessions/:id/confirm` | tablet | `confirm_token`, position → the punch (201; a repeat returns it again with `duplicate: true`). 409 `CONFIRM_EXPIRED`: scan again. |
| `POST /punches/sessions/:id/not-me` | tablet | `confirm_token` → a try; a new challenge, or blocked. |
| `POST /punches/sessions/:id/change-site` | tablet | Legacy compatibility only; absent from the current punch screen. Existing travel records remain available to HR. |
| `POST /punches/sessions/:id/manual` | tablet | After the try limit: `employee_code`, `name`, position → a manual request for HR with the crops. |
| `GET /tablet/sites` | tablet | Other active sites, for the separate transfer request form. |
| `GET /tablet/summary` | tablet | Today's counts, current presence and department headcount for this site. |
| `GET /tablet/attendance/day?date=YYYY-MM-DD` | tablet | Read-only daily site register. |
| `GET /tablet/attendance/month?ym=YYYY-MM` | tablet | Read-only monthly site register and daily bar-chart counts. |
| `GET /tablet/transfers` · `POST /tablet/transfers` | tablet | List outgoing requests or request transfer of a person currently on site; no implicit punches. |
| `GET /site-transfer-requests` · `POST /site-transfer-requests/:id/decide` | HR | List requests (`attendance.read`) or approve/reject (`attendance.write`); no attendance or travel-pay changes. |
| `POST /employees/:id/face` | HR (`people.write`) | Deferred: `409 FACE_REGISTRATION_AT_SITE`; no face analysis or template changes. |
| `GET /employees/:id/face-registration` | HR (`people.read`) | Current face status, latest authorization and repeated approved manual failure hint. |
| `POST /employees/:id/face-registration/authorize` | HR (`people.write`) | Record a reason and allow one replacement within seven days; existing live approval is reused without extending it. |
| `POST /employees/:id/face-registration/revoke` | HR (`people.write`) | Cancel the exact unused approval identified by `authorization_id`; existing templates remain intact. |
| `GET /face-exceptions/:id/crops/:n` | HR (`attendance.read`) | One face crop of a manual request. |
| `GET /site-changes` · `PATCH /site-changes/:id` | HR | The list (with `meta.unreviewed`) · set the travel minutes with a reason. |
| `GET /punch-attempts.csv?from&to` | HR (`attendance.read` + `reports.export`) | The attempt log, for tuning thresholds. |

The face service itself (`face/service/app/main.py`, `127.0.0.1:8100`, header `X-Face-Token`):
- `GET /health`
- `POST /analyze` (multipart `frames` ×1–3, `request_id`) → per frame: faces, box, landmarks, yaw, quality, live score, embedding, and the aligned crop of the first frame.
- 503 `busy` when its single worker cannot start within `FACE_QUEUE_WAIT_MS`.

The backend's client is `createFaceClient` (face/src/client.js).

## 4. Tablet

`frontend/src/pages/tablet/Tablet.jsx` opens the site workspace. Its dashboard and read-only registers live in `frontend/src/components/tablet/`.

1. **Today:** five attendance counts, department headcount donut, current on-site people and a monthly attendance bar chart. Select a department to see names or a day bar to open its register.
2. **Daily register** and **Monthly register:** read-only attendance for the signed-in site, with date/month controls; no HR profile or payroll access.
3. **Transfer requests:** choose a person currently at this site, a destination, departure date and reason. HR reviews the request in Approvals. The request never creates a punch or travel pay.
4. **Punch in / out** → camera guidance until the frame is right → "Hold still…" → three pictures → "Checking…" (with the same `request_id` when retrying a busy service) → "Is this you?" → confirm IN/OUT or **This is not me**. Transfers are absent from this screen.
5. **Try again** with tries left; after the last, the **ID and name form** → "Sent to HR".
6. **Register face:** select an active employee without a current template or with a usable HR re-registration approval; look straight, turn left, turn right, blink, then review four photos before saving. Registration does not punch attendance. Replacement consumes the approval only after a successful save.
7. **No network:** show the message and disable writes; cancel camera capture and return to the workspace.

Messages are in `face/src/messages.js` (`messageFor`), shared by the backend and the tablet. Guidance is `face/src/guidance.js`, served through `frontend/src/services/face.js`.

## 5. Hosting

- The face service runs on the same machine as the backend, on `127.0.0.1:8100`, one worker, under systemd (`face/deploy/ajpwer-face.service`: `MemoryMax=700M`, `Restart=always`). Only the backend calls it, with `X-Face-Token`. **Nginx never forwards to port 8100.**
- Models are not in git (`face/.gitignore`). `python download_models.py` fetches them into `face/service/models` at every deploy and checks each file's size (and checksum where pinned); the systemd unit checks them again before it starts.
- Backend `.env`: `FACE_SERVICE_URL` and `FACE_SERVICE_TOKEN` are required (the backend will not start without them); the `FACE_*` thresholds are optional with the defaults in `.env.example`.
- Development: `npm run face:install` once, then set `FACE_SERVICE_DEV=1` in `.env` and `npm run dev` starts the face service too.
- Tests: `npm run service:test -w @ajpwer/face` (Python), `npm test` (the backend tests mock the face service).

Step-by-step install, memory and swap: [docs/OPERATIONS.md](../docs/OPERATIONS.md).
