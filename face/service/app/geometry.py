"""Pure image arithmetic: head turn from landmarks, crop boxes, quality. No models, easy to test."""

import math

import numpy as np

# Depth of the nose tip in front of the eyes, as a share of the distance between the eyes.
NOSE_DEPTH_RATIO = 0.55


def yaw_from_landmarks(landmarks) -> float:
    """
    Head turn in degrees from YuNet's five landmarks (right eye, left eye, nose tip,
    right mouth corner, left mouth corner — the person's right and left). Positive
    means the person has turned to their own left: in an unmirrored camera frame the
    nose moves towards the image's right.

    Model: the eyes sit either side of the head's axis and the nose tip stands out
    in front of them. Turning by θ shortens the eye line to d·cosθ and moves the nose
    sideways by p·sinθ, so offset / eye line = (p/d)·tanθ.
    """
    lm = np.asarray(landmarks, dtype=np.float64).reshape(5, 2)
    eye_a, eye_b, nose = lm[0], lm[1], lm[2]
    eye_mid = (eye_a + eye_b) / 2.0
    eye_dist = float(np.linalg.norm(eye_b - eye_a))
    if eye_dist < 1e-6:
        return 0.0
    ratio = float(nose[0] - eye_mid[0]) / eye_dist
    return round(math.degrees(math.atan(ratio / NOSE_DEPTH_RATIO)), 1)


def spoof_crop_box(box, scale: float, img_w: int, img_h: int):
    """
    The anti-spoofing crop: the face box grown by `scale` about its centre, shrunk
    if it would leave the image, clipped to the image (as the Silent-Face models
    were trained). Returns x1, y1, x2, y2 inclusive.
    """
    x, y, w, h = [float(v) for v in box]
    w = max(w, 1.0)
    h = max(h, 1.0)
    scale = min((img_h - 1) / h, (img_w - 1) / w, scale)
    new_w, new_h = w * scale, h * scale
    cx, cy = x + w / 2.0, y + h / 2.0
    x1 = max(0, int(cx - new_w / 2.0))
    y1 = max(0, int(cy - new_h / 2.0))
    x2 = min(img_w - 1, int(cx + new_w / 2.0))
    y2 = min(img_h - 1, int(cy + new_h / 2.0))
    return x1, y1, x2, y2


def softmax(logits) -> np.ndarray:
    x = np.asarray(logits, dtype=np.float64).reshape(-1)
    e = np.exp(x - x.max())
    return e / e.sum()


def l2_normalise(vec) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def face_quality(gray_face) -> dict:
    """Brightness (mean grey 0–255), sharpness (variance of the Laplacian) and size of the face region."""
    import cv2

    g = np.asarray(gray_face)
    if g.size == 0:
        return {"brightness": 0.0, "sharpness": 0.0, "face_px": 0}
    return {
        "brightness": round(float(g.mean()), 1),
        "sharpness": round(float(cv2.Laplacian(g, cv2.CV_64F).var()), 1),
        "face_px": int(min(g.shape[:2])),
    }
