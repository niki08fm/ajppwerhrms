"""
The four server models, loaded once:

1. YuNet (OpenCV Zoo, face_detection_yunet_2023mar.onnx) via cv2.FaceDetectorYN —
   finds each face and its five landmarks; the landmarks give the head turn.
2. SFace (OpenCV Zoo, face_recognition_sface_2021dec.onnx) via cv2.FaceRecognizerSF —
   alignCrop to 112×112, then feature: 128 numbers, normalised to length 1.
3. MiniFASNetV2 (MiniFASNetV2.onnx, onnxruntime) — face crop grown 2.7×, 80×80 BGR.
4. MiniFASNetV1SE (MiniFASNetV1SE.onnx, onnxruntime) — crop grown 4.0×.
   The live-face score is the average of 3 and 4's "real" probability (class 1).

Frames are analysed and forgotten: nothing is written to disk. The only image that
leaves is the small aligned 112×112 face crop of the first frame, which the backend
keeps for a manual request and deletes with the gate snapshots.
"""

import base64
import time

import cv2
import numpy as np

from .config import MODEL_FILES, MODEL_VERSION, Settings
from .geometry import face_quality, l2_normalise, softmax, spoof_crop_box, yaw_from_landmarks

LIVE_MODELS = (("live_v2", 2.7), ("live_v1se", 4.0))


class BadImage(ValueError):
    """The upload is not a readable image."""


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR) if arr.size else None
    if img is None:
        raise BadImage("A frame is not a readable JPEG or PNG image.")
    return img


class LiveModel:
    def __init__(self, path, scale: float):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.scale = scale
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        shape = inp.shape[2:]
        self.size = tuple(int(s) if isinstance(s, int) else 80 for s in shape) if len(shape) == 2 else (80, 80)

    def real_probability(self, img: np.ndarray, box) -> float:
        h, w = img.shape[:2]
        x1, y1, x2, y2 = spoof_crop_box(box, self.scale, w, h)
        crop = img[y1 : y2 + 1, x1 : x2 + 1]
        # Same preprocessing as the models' own inference: BGR, 0–255, CHW, no normalisation.
        face = cv2.resize(crop, (self.size[1], self.size[0])).astype(np.float32)
        tensor = np.transpose(face, (2, 0, 1))[None, ...]
        logits = self.session.run(None, {self.input_name: tensor})[0]
        return float(softmax(logits)[1])


class FaceEngine:
    def __init__(self, settings: Settings):
        d = settings.models_dir
        self.settings = settings
        self.detector = cv2.FaceDetectorYN.create(str(d / MODEL_FILES["detector"]), "", (320, 320), settings.detect_score, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create(str(d / MODEL_FILES["recognizer"]), "")
        self.live = {name: LiveModel(d / MODEL_FILES[name], scale) for name, scale in LIVE_MODELS}

    def _prepare(self, img: np.ndarray) -> np.ndarray:
        h, w = img.shape[:2]
        if w > self.settings.max_width:
            s = self.settings.max_width / w
            img = cv2.resize(img, (self.settings.max_width, int(round(h * s))), interpolation=cv2.INTER_AREA)
        return img

    def _detect(self, img: np.ndarray):
        h, w = img.shape[:2]
        self.detector.setInputSize((w, h))
        _, faces = self.detector.detect(img)
        return [] if faces is None else list(faces)

    def analyze_frame(self, data: bytes, index: int, want_crop: bool) -> dict:
        img = self._prepare(decode_image(data))
        faces = self._detect(img)
        out = {"index": index, "faces": len(faces), "face": None, "yaw": None, "quality": None, "live": None, "embedding": None, "crop_jpeg": None}
        if len(faces) != 1:
            return out
        row = faces[0]
        box = [float(v) for v in row[0:4]]
        landmarks = [[float(row[4 + 2 * i]), float(row[5 + 2 * i])] for i in range(5)]
        out["face"] = {"box": [round(v, 1) for v in box], "score": round(float(row[14]), 4), "landmarks": [[round(x, 1), round(y, 1)] for x, y in landmarks]}
        out["yaw"] = yaw_from_landmarks(landmarks)

        h, w = img.shape[:2]
        x, y, bw, bh = box
        gx1, gy1 = max(0, int(x)), max(0, int(y))
        gx2, gy2 = min(w, int(x + bw)), min(h, int(y + bh))
        out["quality"] = face_quality(cv2.cvtColor(img[gy1:gy2, gx1:gx2], cv2.COLOR_BGR2GRAY))

        v2 = self.live["live_v2"].real_probability(img, box)
        v1se = self.live["live_v1se"].real_probability(img, box)
        out["live"] = {"v2": round(v2, 4), "v1se": round(v1se, 4), "score": round((v2 + v1se) / 2.0, 4)}

        aligned = self.recognizer.alignCrop(img, row)
        feature = l2_normalise(self.recognizer.feature(aligned))
        out["embedding"] = [round(float(v), 6) for v in feature]
        if want_crop:
            ok, jpg = cv2.imencode(".jpg", aligned, [cv2.IMWRITE_JPEG_QUALITY, 85])
            out["crop_jpeg"] = base64.b64encode(jpg.tobytes()).decode("ascii") if ok else None
        return out

    def analyze(self, frames: list[bytes]) -> dict:
        started = time.perf_counter()
        results = [self.analyze_frame(f, i, want_crop=(i == 0)) for i, f in enumerate(frames)]
        return {"model_version": MODEL_VERSION, "frames": results, "ms": int((time.perf_counter() - started) * 1000)}
