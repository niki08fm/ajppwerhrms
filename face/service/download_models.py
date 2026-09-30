"""
Fetch the four server models into face/service/models (or FACE_SERVICE_MODELS_DIR) and
check each file's size. Run at every deploy; files already present with the right
size are left alone. All four are Apache 2.0 licensed; none is committed to git.

    python download_models.py            # download what is missing, check all
    python download_models.py --check    # only check, download nothing
"""

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("FACE_SERVICE_MODELS_DIR") or HERE / "models")

ZOO = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"
FAS = "https://github.com/yakhyo/face-anti-spoofing/releases/download/weights"

# size: exact byte count (a (min, max) range is also accepted). sha256: checked when given.
MODELS = [
    {
        "file": "face_detection_yunet_2023mar.onnx",
        "url": f"{ZOO}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "size": 232_589,
        "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        "what": "YuNet face detection (OpenCV Zoo, Apache 2.0)",
    },
    {
        "file": "face_recognition_sface_2021dec.onnx",
        "url": f"{ZOO}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "size": 38_696_353,
        "sha256": "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
        "what": "SFace face recognition (OpenCV Zoo, Apache 2.0)",
    },
    {
        "file": "MiniFASNetV2.onnx",
        "url": f"{FAS}/MiniFASNetV2.onnx",
        "size": 1_743_581,
        "sha256": "b32929adc2d9c34b9486f8c4c7bc97c1b69bc0ea9befefc380e4faae4e463907",
        "what": "MiniFASNetV2 live-face check (yakhyo/face-anti-spoofing, Apache 2.0)",
    },
    {
        "file": "MiniFASNetV1SE.onnx",
        "url": f"{FAS}/MiniFASNetV1SE.onnx",
        "size": 1_742_335,
        "sha256": "ebab7f90c7833fbccd46d3a555410e78d969db5438e169b6524be444862b3676",
        "what": "MiniFASNetV1SE live-face check (yakhyo/face-anti-spoofing, Apache 2.0)",
    },
]


def size_ok(n: int, expected) -> bool:
    if isinstance(expected, tuple):
        return expected[0] <= n <= expected[1]
    return n == expected


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check(m) -> str | None:
    """None when the file is present and right; otherwise what is wrong."""
    path = MODELS_DIR / m["file"]
    if not path.is_file():
        return "missing"
    n = path.stat().st_size
    if not size_ok(n, m["size"]):
        return f"wrong size {n:,} bytes (expected {m['size']})"
    if m["sha256"] and sha256(path) != m["sha256"]:
        return "wrong checksum"
    return None


def download(m) -> None:
    path = MODELS_DIR / m["file"]
    tmp = path.with_suffix(path.suffix + ".part")
    req = urllib.request.Request(m["url"], headers={"User-Agent": "AJPWER-Workforce model download"})
    with urllib.request.urlopen(req, timeout=120) as r, tmp.open("wb") as out:
        while chunk := r.read(1 << 20):
            out.write(chunk)
    tmp.replace(path)


def main(argv) -> int:
    only_check = "--check" in argv
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    failed = False
    for m in MODELS:
        problem = check(m)
        if problem and not only_check:
            print(f"Downloading {m['file']} — {m['what']}")
            try:
                download(m)
            except Exception as e:  # noqa: BLE001 - report and carry on to the next file
                print(f"  could not download: {e}")
            problem = check(m)
        path = MODELS_DIR / m["file"]
        if problem:
            failed = True
            print(f"FAIL  {m['file']}: {problem}")
        else:
            print(f"ok    {m['file']}  {path.stat().st_size:,} bytes  sha256 {sha256(path)}")
    if failed:
        print(f"\nSome model files are missing or wrong in {MODELS_DIR}. The face service will not start until they are fixed.")
        return 1
    print(f"\nAll four models are in {MODELS_DIR}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
