import asyncio
import time

import cv2
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.engine import decode_image
from app.main import create_app

TOKEN = "t" * 32


def jpeg() -> bytes:
    ok, buf = cv2.imencode(".jpg", np.full((120, 160, 3), 128, np.uint8))
    assert ok
    return buf.tobytes()


class FakeEngine:
    """Stands in for the four models: decodes like the real one, answers one face."""

    def __init__(self, delay=0.0):
        self.delay = delay
        self.calls = 0

    def analyze(self, frames):
        self.calls += 1
        for f in frames:
            decode_image(f)
        if self.delay:
            time.sleep(self.delay)
        frame = {"index": 0, "faces": 1, "yaw": 0.0, "live": {"v2": 0.9, "v1se": 0.9, "score": 0.9}, "embedding": [1.0] + [0.0] * 127}
        return {"model_version": "sface-2021dec", "frames": [dict(frame, index=i) for i in range(len(frames))], "ms": 1}


def client(engine=None, **settings):
    s = Settings(token=TOKEN, **settings)
    return TestClient(create_app(settings=s, engine=engine or FakeEngine()))


def post(c, frames=1, token=TOKEN, request_id="req-00000001"):
    return c.post(
        "/analyze",
        headers={"X-Face-Token": token} if token else {},
        data={"request_id": request_id},
        files=[("frames", (f"f{i}.jpg", jpeg(), "image/jpeg")) for i in range(frames)],
    )


def test_token_is_required():
    c = client()
    assert c.get("/health").status_code == 401
    assert c.get("/health", headers={"X-Face-Token": "wrong"}).status_code == 401
    assert post(c, token=None).status_code == 401
    assert post(c, token="wrong-token-wrong-token-wrong").status_code == 401
    r = c.get("/health", headers={"X-Face-Token": TOKEN})
    assert r.status_code == 200
    assert r.json()["model_version"] == "sface-2021dec"


def test_analyze_returns_one_result_per_frame_and_echoes_the_request_id():
    r = post(client(), frames=2, request_id="abc-123-xyz")
    assert r.status_code == 200
    body = r.json()
    assert body["request_id"] == "abc-123-xyz"
    assert [f["index"] for f in body["frames"]] == [0, 1]


def test_frame_count_and_size_limits():
    c = client()
    assert post(c, frames=4).status_code == 422
    small = client(max_frame_bytes=100)
    assert post(small).status_code == 413


def test_unreadable_image_is_a_clear_422():
    c = client()
    r = c.post("/analyze", headers={"X-Face-Token": TOKEN}, data={"request_id": "req-00000001"}, files=[("frames", ("x.jpg", b"not an image", "image/jpeg"))])
    assert r.status_code == 422
    assert r.json()["error"] == "bad_image"


def test_busy_when_the_worker_cannot_start_in_time():
    engine = FakeEngine(delay=0.6)
    app = create_app(settings=Settings(token=TOKEN, queue_wait_ms=50), engine=engine)

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://face") as c:
            def req(rid):
                return c.post(
                    "/analyze",
                    headers={"X-Face-Token": TOKEN},
                    data={"request_id": rid},
                    files=[("frames", ("f.jpg", jpeg(), "image/jpeg"))],
                )

            return await asyncio.gather(req("req-00000001"), req("req-00000002"))

    a, b = asyncio.run(run())
    codes = sorted([a.status_code, b.status_code])
    assert codes == [200, 503]
    busy = a if a.status_code == 503 else b
    assert busy.json()["error"] == "busy"
    assert engine.calls == 1


def test_refuses_to_start_without_models(tmp_path):
    app = create_app(settings=Settings(token=TOKEN, models_dir=tmp_path))
    with pytest.raises(RuntimeError, match="Model file missing"):
        with TestClient(app):
            pass
