"""Entry point: `python -m app.server` (systemd runs this). One worker, localhost only."""

import logging
import os

import uvicorn

from .main import create_app


def run():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(
        create_app(),
        host="127.0.0.1",  # never exposed: only the backend on this machine calls it
        port=int(os.environ.get("FACE_SERVICE_PORT", "8100")),
        workers=1,
        access_log=False,
    )


if __name__ == "__main__":
    run()
