"""Run real YAMNet -> enrollment -> streaming -> rosbridge in an isolated workspace."""

import json
import queue
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from websockets.sync.server import serve

from physical_shazam.audio import HOP, SAMPLE_RATE, decode
from physical_shazam.server import STATIC, create_app


def main():
    received = queue.Queue()

    def sink(socket):
        for raw in socket:
            message = json.loads(raw)
            if message["op"] == "publish":
                received.put(json.loads(message["msg"]["data"]))

    with tempfile.TemporaryDirectory() as temporary, serve(sink, "127.0.0.1", 0) as bridge:
        threading.Thread(target=bridge.serve_forever, daemon=True).start()
        with TestClient(create_app(Path(temporary))) as client:
            deadline = time.monotonic() + 120
            while client.get("/api/status").json()["model_status"] == "loading":
                if time.monotonic() > deadline:
                    raise RuntimeError("Model did not load within 120 seconds")
                time.sleep(0.2)
            assert client.get("/api/status").json()["model_status"] == "ready"
            clip = (STATIC / "samples/two-tone.wav").read_bytes()
            example = client.post("/api/examples", files={"file": ("chime.wav", clip)}).json()
            response = client.post(
                "/api/cues", json={"name": "Synthetic lab chime", "examples": [example["token"]]}
            )
            assert response.status_code == 201, response.text
            client.put(
                "/api/ros",
                json={"enabled": True, "url": f"ws://127.0.0.1:{bridge.socket.getsockname()[1]}"},
            )
            deadline = time.monotonic() + 5
            while client.get("/api/status").json()["ros"]["status"] != "connected":
                if time.monotonic() > deadline:
                    raise RuntimeError("Local rosbridge sink did not connect")
                time.sleep(0.05)
            negative = (STATIC / "samples/room-noise.wav").read_bytes()
            negative_result = client.post(
                "/api/test", files={"file": ("noise.wav", negative)}
            ).json()
            assert not negative_result["events"], "Synthetic room-noise negative triggered"
            wave = decode((STATIC / "samples/two-tone-test.wav").read_bytes())
            frames, events = [], []
            with client.websocket_connect("/api/listen") as socket:
                socket.send_json({"sample_rate": SAMPLE_RATE})
                assert socket.receive_json()["type"] == "ready"
                for index in range(0, len(wave), HOP):
                    socket.send_bytes(wave[index : index + HOP].tobytes())
                    while True:
                        message = socket.receive_json()
                        if message["type"] == "ack":
                            break
                        frames.append(message)
                        events.extend(message.get("events", []))
            assert len(events) == 2, "Expected the real model to recognize both replayed chimes"
            delivered = received.get(timeout=3)
            assert delivered["type"] == "cue.detected"
            assert delivered["cue_id"] == response.json()["id"]
            report = {
                "encoder": "YAMNet (real pretrained model)",
                "examples": 1,
                "positive_events": len(events),
                "negative_events": len(negative_result["events"]),
                "peak_similarity": max(
                    score["score"] for frame in frames for score in frame["scores"]
                ),
                "median_inference_ms": float(
                    np.median([frame["inference_ms"] for frame in frames])
                ),
                "rosbridge_delivery": "verified with local protocol sink",
                "note": "Synthetic fixture check; not a household accuracy or ROS graph benchmark.",
            }
            print(json.dumps(report, indent=2))
        bridge.shutdown()


if __name__ == "__main__":
    main()
