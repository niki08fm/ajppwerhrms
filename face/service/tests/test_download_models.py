import importlib
import ssl
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

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


def secure_context(monkeypatch):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    load_roots = Mock()
    monkeypatch.setattr(context, "load_verify_locations", load_roots)
    factory = Mock(return_value=context)
    monkeypatch.setattr(dm.ssl, "create_default_context", factory)
    return context, load_roots, factory


def assert_verified(context):
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_download_tls_supplements_system_roots_without_replacing_them(monkeypatch):
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    context, load_roots, factory = secure_context(monkeypatch)
    bundle = Mock(return_value="/test/certifi.pem")
    monkeypatch.setattr(dm, "certifi", SimpleNamespace(where=bundle))

    assert dm.download_tls_context() is context
    # No cafile argument: Python loads the operating system's trusted roots.
    factory.assert_called_once_with()
    load_roots.assert_called_once_with(cafile="/test/certifi.pem")
    bundle.assert_called_once_with()
    assert_verified(context)


@pytest.mark.parametrize("configured", [
    {"SSL_CERT_FILE": "/test/company-ca.pem"},
    {"SSL_CERT_DIR": "/test/company-ca-directory"},
    {"SSL_CERT_FILE": "/test/company-ca.pem", "SSL_CERT_DIR": "/test/company-ca-directory"},
])
def test_download_tls_preserves_explicit_ca_configuration(monkeypatch, configured):
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    for name, value in configured.items():
        monkeypatch.setenv(name, value)
    context, load_roots, factory = secure_context(monkeypatch)
    bundle = Mock(return_value="/test/certifi.pem")
    monkeypatch.setattr(dm, "certifi", SimpleNamespace(where=bundle))

    assert dm.download_tls_context() is context
    factory.assert_called_once_with()
    bundle.assert_not_called()
    load_roots.assert_not_called()
    assert_verified(context)


def test_download_tls_keeps_verification_without_certifi(monkeypatch):
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    context, load_roots, factory = secure_context(monkeypatch)
    monkeypatch.setattr(dm, "certifi", None)

    assert dm.download_tls_context() is context
    factory.assert_called_once_with()
    load_roots.assert_not_called()
    assert_verified(context)
