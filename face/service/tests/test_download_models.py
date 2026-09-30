import importlib

import download_models as dm


def test_size_rules():
    assert dm.size_ok(232_589, 232_589)
    assert not dm.size_ok(232_588, 232_589)
    assert dm.size_ok(1_500_000, (1_000_000, 4_000_000))
    assert not dm.size_ok(10, (1_000_000, 4_000_000))


def test_check_reports_missing_and_wrong_size(tmp_path, monkeypatch):
    monkeypatch.setenv("FACE_SERVICE_MODELS_DIR", str(tmp_path))
    mod = importlib.reload(dm)
    m = {"file": "x.onnx", "size": 5, "sha256": None}
    assert mod.check(m) == "missing"
    (tmp_path / "x.onnx").write_bytes(b"1234")
    assert "wrong size" in mod.check(m)
    (tmp_path / "x.onnx").write_bytes(b"12345")
    assert mod.check(m) is None
    assert mod.check({**m, "sha256": "0" * 64}) == "wrong checksum"
    monkeypatch.delenv("FACE_SERVICE_MODELS_DIR")
    importlib.reload(dm)


def test_every_model_is_listed_once_with_a_size():
    files = [m["file"] for m in dm.MODELS]
    assert files == ["face_detection_yunet_2023mar.onnx", "face_recognition_sface_2021dec.onnx", "MiniFASNetV2.onnx", "MiniFASNetV1SE.onnx"]
    assert all(m["size"] for m in dm.MODELS)
