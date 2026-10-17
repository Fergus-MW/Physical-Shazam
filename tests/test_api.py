import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from physical_shazam.audio import SAMPLE_RATE, wav_bytes
from physical_shazam.server import create_app


class TestEncoder:
    """Deterministic test double for transport/persistence tests, not an accuracy claim."""

    __test__ = False
    name = "test-encoder"

    def load(self):
        pass

    def embed(self, samples):
        return np.array([1, 0, 0], dtype=np.float32)


def make_client(tmp_path):
    return TestClient(create_app(tmp_path, TestEncoder()))


def wait_for_model(client):
    for _ in range(100):
        if client.get("/api/status").json()["model_status"] == "ready":
            return
        time.sleep(0.01)
    raise AssertionError("Test encoder did not initialize")


def audio(seconds=2):
    return (
        0.2 * np.sin(2 * np.pi * 800 * np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE)
    ).astype(np.float32)


def upload(client):
    response = client.post(
        "/api/examples", files={"file": ("cue.wav", wav_bytes(audio()), "audio/wav")}
    )
    assert response.status_code == 200, response.text
    return response.json()["token"]


def test_full_enrollment_streaming_event_and_restart(tmp_path):
    with make_client(tmp_path) as client:
        wait_for_model(client)
        token = upload(client)
        response = client.post("/api/cues", json={"name": "My chime", "examples": [token]})
        assert response.status_code == 201
        cue_id = response.json()["id"]
        assert "prototype" not in response.json()
        assert (tmp_path / "examples" / cue_id / "1.wav").exists()
        assert client.get(f"/api/cues/{cue_id}/audio/1").headers["content-type"] == "audio/wav"
        assert client.get(f"/api/cues/{cue_id}/audio/6").status_code == 404
        events = []
        with client.websocket_connect("/api/listen") as socket:
            socket.send_json({"sample_rate": SAMPLE_RATE})
            assert socket.receive_json()["type"] == "ready"
            for chunk in np.array_split(audio(3), 6):
                socket.send_bytes(chunk.tobytes())
                while True:
                    message = socket.receive_json()
                    if message["type"] == "ack":
                        break
                    events.extend(message.get("events", []))
        assert len(events) == 1
        assert events[0]["name"] == "My chime"
        assert events[0]["ros_delivery"] == "disabled"
        assert client.get("/api/status").json()["listening"] is False
    with make_client(tmp_path) as client:
        assert client.get("/api/status").json()["cues"][0]["id"] == cue_id
        assert len(client.get("/api/status").json()["events"]) == 1
        assert client.delete(f"/api/cues/{cue_id}").status_code == 200
        assert not (tmp_path / "examples" / cue_id).exists()


def test_enrollment_validation_and_recording_tests_do_not_publish(tmp_path):
    with make_client(tmp_path) as client:
        wait_for_model(client)
        assert client.post("/api/examples", files={"file": ("bad.wav", b"bad")}).status_code == 400
        silence = wav_bytes(np.zeros(SAMPLE_RATE * 2))
        assert (
            client.post("/api/examples", files={"file": ("silent.wav", silence)}).status_code == 400
        )
        token = upload(client)
        assert (
            client.post("/api/cues", json={"name": "A", "examples": [token, token]}).status_code
            == 400
        )
        assert client.post("/api/cues", json={"name": " ", "examples": [token]}).status_code == 422
        client.post("/api/cues", json={"name": "A", "examples": [token]})
        result = client.post("/api/test", files={"file": ("test.wav", wav_bytes(audio(4)))}).json()
        assert len(result["events"]) == 1
        assert result["published"] is False
        assert client.get("/api/status").json()["events"] == []
        assert not (tmp_path / "events.jsonl").exists()


def test_live_audio_rejects_malformed_chunks_and_second_session(tmp_path):
    with make_client(tmp_path) as client:
        wait_for_model(client)
        with client.websocket_connect("/api/listen") as socket:
            socket.send_json({"sample_rate": SAMPLE_RATE})
            socket.receive_json()
            with client.websocket_connect("/api/listen") as second:
                assert second.receive_json()["type"] == "error"
            # The rejected connection must not unlock the first stream.
            assert client.get("/api/status").json()["listening"] is True
            socket.send_bytes(b"bad")
            assert socket.receive_json()["type"] == "error"


def test_ros_configuration_validation_and_missing_teacher_key(tmp_path, monkeypatch):
    monkeypatch.setattr("physical_shazam.teacher.settings", lambda: {"key": "", "model": "test"})
    with make_client(tmp_path) as client:
        wait_for_model(client)
        token = upload(client)
        assert client.post("/api/teacher", json={"examples": [token]}).status_code == 409
        assert (
            client.put("/api/ros", json={"enabled": True, "url": "https://example.com"}).status_code
            == 422
        )
        assert client.put("/api/ros", json={"topic": "/bad topic"}).status_code == 422
        assert client.post("/api/ros/test").json()["delivery"] == "disabled"


def test_background_calibration_rejects_short_clip(tmp_path):
    with make_client(tmp_path) as client:
        wait_for_model(client)
        result = client.post("/api/background", files={"file": ("room.wav", wav_bytes(audio(2)))})
        assert result.status_code == 400
        result = client.post("/api/background", files={"file": ("room.wav", wav_bytes(audio(4)))})
        assert result.status_code == 200
        assert client.get("/api/status").json()["background_calibrated"] is True


@pytest.mark.parametrize("payload", [[], None, 42, "hello"])
def test_listener_rejects_non_object_config_and_releases_session(tmp_path, payload):
    with make_client(tmp_path) as client:
        wait_for_model(client)
        with client.websocket_connect("/api/listen") as socket:
            socket.send_json(payload)
            assert socket.receive_json()["type"] == "error"
        with client.websocket_connect("/api/listen") as socket:
            socket.send_json({"sample_rate": SAMPLE_RATE})
            assert socket.receive_json()["type"] == "ready"


@pytest.mark.parametrize("phase", ["setup", "audio"])
def test_listener_rejects_the_wrong_websocket_frame_type(tmp_path, phase):
    with make_client(tmp_path) as client:
        wait_for_model(client)
        with client.websocket_connect("/api/listen") as socket:
            if phase == "setup":
                socket.send_bytes(b"{}")
            else:
                socket.send_json({"sample_rate": SAMPLE_RATE})
                socket.receive_json()
                socket.send_text("not PCM")
            assert socket.receive_json()["type"] == "error"


def test_unexpected_teacher_failure_does_not_leave_a_running_job(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "physical_shazam.teacher.settings", lambda: {"key": "test", "model": "test"}
    )

    def fail(*args):
        raise RuntimeError("unexpected provider response")

    monkeypatch.setattr("physical_shazam.teacher.analyze", fail)
    with make_client(tmp_path) as client:
        wait_for_model(client)
        token = upload(client)
        job = client.post("/api/teacher", json={"examples": [token]}).json()
        for _ in range(50):
            state = client.get(f"/api/teacher/{job['id']}").json()
            if state["status"] != "running":
                break
            time.sleep(0.01)
        assert state["status"] == "error"
        assert "unexpected provider response" not in state["error"]
