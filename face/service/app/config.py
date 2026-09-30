"""Settings from the environment. Only the backend calls this service, on 127.0.0.1."""

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent

MODEL_VERSION = "sface-2021dec"

MODEL_FILES = {
    "detector": "face_detection_yunet_2023mar.onnx",
    "recognizer": "face_recognition_sface_2021dec.onnx",
    "live_v2": "MiniFASNetV2.onnx",
    "live_v1se": "MiniFASNetV1SE.onnx",
}


def _int(name: str, default: int) -> int:
    v = os.environ.get(name, "")
    return int(v) if v.strip() else default


def _float(name: str, default: float) -> float:
    v = os.environ.get(name, "")
    return float(v) if v.strip() else default


@dataclass(frozen=True)
class Settings:
    token: str = field(default_factory=lambda: os.environ.get("FACE_SERVICE_TOKEN", ""))
    models_dir: Path = field(default_factory=lambda: Path(os.environ.get("FACE_SERVICE_MODELS_DIR") or SERVICE_DIR / "models"))
    # How long a request waits for the single worker before answering "busy".
    queue_wait_ms: int = field(default_factory=lambda: _int("FACE_QUEUE_WAIT_MS", 2000))
    max_frames: int = 3
    max_frame_bytes: int = field(default_factory=lambda: _int("FACE_MAX_FRAME_BYTES", 1_500_000))
    # Frames are scaled down to this width before detection.
    max_width: int = 640
    detect_score: float = field(default_factory=lambda: _float("FACE_DETECT_SCORE", 0.8))

    def check(self) -> list[str]:
        problems = []
        if len(self.token) < 24:
            problems.append("FACE_SERVICE_TOKEN must be set to at least 24 characters (the same value as the backend's).")
        for name in MODEL_FILES.values():
            if not (self.models_dir / name).is_file():
                problems.append(f"Model file missing: {self.models_dir / name}. Run: python download_models.py")
        return problems
