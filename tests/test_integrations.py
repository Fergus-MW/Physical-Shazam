import json
import queue
import threading
import time

import httpx
import numpy as np
from websockets.sync.server import serve

from physical_shazam import teacher
from physical_shazam.ros import RosPublisher


def wait_until(predicate, seconds=4):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Condition was not reached")


def test_gemini_sends_actual_wav_audio_and_validates_result(monkeypatch):
    monkeypatch.setattr(
        teacher, "settings", lambda: {"key": "test-key", "model": "gemini-2.5-flash"}
    )
    assessment = {
        "label": "Chime",
        "description": "Two falling tones.",
        "confusable_sounds": ["Appliance beep"],
        "recording_advice": "Move closer.",
        "consistent_examples": True,
    }

    def handle(request):
        assert request.headers["x-goog-api-key"] == "test-key"
        assert "test-key" not in str(request.url)
        payload = json.loads(request.content)
        assert payload["contents"][0]["parts"][1]["inlineData"]["mimeType"] == "audio/wav"
        assert payload["generationConfig"]["responseMimeType"] == "application/json"
        return httpx.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(assessment)}]}}]}
        )

    original = httpx.Client
    monkeypatch.setattr(
        teacher.httpx,
        "Client",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    result = teacher.analyze([np.ones(16000, dtype=np.float32) * 0.1])
    assert result["label"] == "Chime"
    assert result["model"] == "gemini-2.5-flash"


def test_rosbridge_advertises_then_publishes_structured_string():
    received = queue.Queue()

    def handle(socket):
        for raw in socket:
            received.put(json.loads(raw))

    with serve(handle, "127.0.0.1", 0) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.socket.getsockname()[1]
        publisher = RosPublisher(
            {"enabled": True, "url": f"ws://127.0.0.1:{port}", "topic": "/physical_shazam/events"}
        )
        try:
            wait_until(lambda: publisher.status == "connected")
            event = {"id": "example", "type": "cue.detected", "name": "Door", "score": 0.91}
            assert publisher.publish(event) == "queued"
            advertise = received.get(timeout=3)
            publish = received.get(timeout=3)
            assert advertise == {
                "op": "advertise",
                "topic": "/physical_shazam/events",
                "type": "std_msgs/msg/String",
            }
            assert publish["op"] == "publish"
            assert json.loads(publish["msg"]["data"]) == event
            wait_until(lambda: publisher.sent == 1)
        finally:
            publisher.close()
        assert received.get(timeout=3)["op"] == "unadvertise"
        server.shutdown()


def test_rosbridge_offline_drops_without_replaying():
    publisher = RosPublisher()
    try:
        publisher.configure({"enabled": True, "url": "ws://127.0.0.1:1", "topic": "/events"})
        assert publisher.publish({"type": "cue.detected"}) == "offline"
        assert publisher.dropped == 1
        assert publisher.queue.empty()
    finally:
        publisher.close()
