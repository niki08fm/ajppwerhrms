"""
Runs the real four models when they are downloaded (python download_models.py) and
a test photo of one face is given in FACE_TEST_IMAGE. Skipped otherwise, so CI
without the model files still passes the rest.
"""

import os
from pathlib import Path

import numpy as np
import pytest

from app.config import Settings

settings = Settings(token="t" * 32)
image = os.environ.get("FACE_TEST_IMAGE")
missing = [p for p in settings.check() if "Model file missing" in p]

pytestmark = pytest.mark.skipif(bool(missing) or not image, reason="needs the downloaded models and FACE_TEST_IMAGE")


@pytest.fixture(scope="module")
def engine():
    from app.engine import FaceEngine

    return FaceEngine(settings)


def test_one_face_gives_a_unit_embedding_live_score_and_crop(engine):
    data = Path(image).read_bytes()
    r = engine.analyze([data])
    f = r["frames"][0]
    assert r["model_version"] == "sface-2021dec"
    assert f["faces"] == 1
    emb = np.asarray(f["embedding"])
    assert emb.shape == (128,)
    assert float(np.linalg.norm(emb)) == pytest.approx(1.0, abs=1e-3)
    assert 0.0 <= f["live"]["score"] <= 1.0
    assert f["crop_jpeg"]


def test_the_same_photo_matches_itself(engine):
    data = Path(image).read_bytes()
    a, b = engine.analyze([data, data])["frames"]
    assert float(np.dot(a["embedding"], b["embedding"])) > 0.99
