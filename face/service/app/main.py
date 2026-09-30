"""
HTTP front of the face service. Listens on 127.0.0.1:8100 only; the backend is its
only caller and sends X-Face-Token. One worker analyses one request at a time; a
request that cannot start within FACE_QUEUE_WAIT_MS gets 503 {"error": "busy"}, which
the backend passes on so the tablet retries the same upload. Busy is never a failed try.
"""

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .config import MODEL_VERSION, Settings
from .engine import BadImage

log = logging.getLogger("ajpwer.face")


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "message": message})


def create_app(settings: Settings | None = None, engine=None, engine_factory=None) -> FastAPI:
    settings = settings or Settings()
    state = {"engine": engine}
    gate = asyncio.Semaphore(1)

    def get_engine():
        if state["engine"] is None:
            if engine_factory is None:
                from .engine import FaceEngine

                state["engine"] = FaceEngine(settings)
            else:
                state["engine"] = engine_factory(settings)
        return state["engine"]

    def authorised(token: str | None) -> bool:
        return bool(settings.token) and token is not None and hmac.compare_digest(token.encode(), settings.token.encode())

    @asynccontextmanager
    async def lifespan(_app):
        # Load the models before accepting requests; refuse to start without them.
        if state["engine"] is None and engine_factory is None:
            problems = settings.check()
            if problems:
                for p in problems:
                    log.error(p)
                raise RuntimeError("Face service cannot start:\n  " + "\n  ".join(problems))
            get_engine()
        yield

    app = FastAPI(title="AJPWER face service", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.get("/health")
    async def health(x_face_token: str | None = Header(default=None)):
        if not authorised(x_face_token):
            return _error(401, "unauthorised", "Missing or wrong X-Face-Token.")
        return {"ok": True, "model_version": MODEL_VERSION, "busy": gate.locked()}

    @app.post("/analyze")
    async def analyze(
        frames: list[UploadFile] = File(...),
        request_id: str = Form(..., min_length=8, max_length=80),
        x_face_token: str | None = Header(default=None),
    ):
        if not authorised(x_face_token):
            return _error(401, "unauthorised", "Missing or wrong X-Face-Token.")
        if not 1 <= len(frames) <= settings.max_frames:
            return _error(422, "bad_request", f"Send between 1 and {settings.max_frames} frames.")
        data = []
        for f in frames:
            b = await f.read(settings.max_frame_bytes + 1)
            if len(b) > settings.max_frame_bytes:
                return _error(413, "too_large", "A frame is too large.")
            data.append(b)
        try:
            await asyncio.wait_for(gate.acquire(), timeout=settings.queue_wait_ms / 1000)
        except asyncio.TimeoutError:
            return _error(503, "busy", "The face service is busy. Retry the same upload.")
        try:
            result = await run_in_threadpool(get_engine().analyze, data)
        except BadImage as e:
            return _error(422, "bad_image", str(e))
        finally:
            gate.release()
        return {"request_id": request_id, **result}

    return app
