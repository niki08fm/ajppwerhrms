import math

import numpy as np
import pytest

from app.geometry import NOSE_DEPTH_RATIO, l2_normalise, softmax, spoof_crop_box, yaw_from_landmarks


def face_landmarks(yaw_deg: float, eye_dist: float = 60.0, cx: float = 320.0, cy: float = 240.0):
    """Five landmarks of a head turned by yaw_deg (positive: to the person's left), projected flat."""
    t = math.radians(yaw_deg)
    half = eye_dist / 2 * math.cos(t)
    nose_dx = NOSE_DEPTH_RATIO * eye_dist * math.sin(t)
    return [[cx - half, cy], [cx + half, cy], [cx + nose_dx, cy + 25], [cx - half * 0.8, cy + 50], [cx + half * 0.8, cy + 50]]


def test_straight_face_has_no_turn():
    assert yaw_from_landmarks(face_landmarks(0)) == 0.0


@pytest.mark.parametrize("deg", [10, 20, 30, 45, -15, -30])
def test_turn_is_recovered_from_landmarks(deg):
    assert yaw_from_landmarks(face_landmarks(deg)) == pytest.approx(deg, abs=0.2)


def test_sign_follows_the_nose():
    assert yaw_from_landmarks(face_landmarks(25)) > 0
    assert yaw_from_landmarks(face_landmarks(-25)) < 0


def test_degenerate_landmarks_do_not_divide_by_zero():
    assert yaw_from_landmarks([[1, 1]] * 5) == 0.0


def test_spoof_crop_grows_about_the_centre():
    x1, y1, x2, y2 = spoof_crop_box([300, 200, 40, 40], 2.7, 640, 480)
    assert (x1 + x2) / 2 == pytest.approx(320, abs=1)
    assert (y1 + y2) / 2 == pytest.approx(220, abs=1)
    assert x2 - x1 == pytest.approx(108, abs=1)


def test_spoof_crop_shrinks_to_fit_and_stays_inside():
    x1, y1, x2, y2 = spoof_crop_box([100, 100, 300, 300], 4.0, 640, 480)
    assert x1 >= 0 and y1 >= 0 and x2 <= 639 and y2 <= 479
    # 4.0× of 300 would be 1200; it is limited by the image height instead.
    assert y2 - y1 <= 479


def test_softmax_and_normalise():
    p = softmax([[0.0, 2.0, 0.0]])
    assert p.sum() == pytest.approx(1.0)
    assert int(np.argmax(p)) == 1
    v = l2_normalise([3.0, 4.0])
    assert float(np.linalg.norm(v)) == pytest.approx(1.0)
    assert l2_normalise([0.0, 0.0]).tolist() == [0.0, 0.0]
