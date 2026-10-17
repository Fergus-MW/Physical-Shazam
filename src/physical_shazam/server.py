import asyncio
import json
import os
import re
import shutil
import threading
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect

from . import teacher
from .audio import (
    HOP,
    SAMPLE_RATE,
    WINDOW,
    WindowBuffer,
    decode,
    prepare,
    rms_db,
    validate_example,
    wav_bytes,
)
from .core import CueStore, Detector
from .encoder import YamnetEncoder
from .ros import RosPublisher

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD = 12 * 1024 * 1024


class Enrollment(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    examples: list[str] = Field(min_length=1, max_length=5)
    threshold: float = Field(default=0.82, ge=0.1, le=0.99)
    teacher_job: str | None = None

    @field_validator("name")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("Give this sound a name.")
        return value.strip()


class CueUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    threshold: float | None = Field(default=None, ge=0.1, le=0.99)
    hits: int | None = Field(default=None, ge=1, le=5)
    cooldown: float | None = Field(default=None, ge=0, le=60)
    enabled: bool | None = None


class TeacherRequest(BaseModel):
    examples: list[str] = Field(min_length=1, max_length=5)
    name: str = Field(default="", max_length=80)


class RosConfig(BaseModel):
    enabled: bool = False
    url: str = "ws://localhost:9090"
    topic: str = "/physical_shazam/events"

    @field_validator("url")
    @classmethod
    def websocket_url(cls, value):
        from urllib.parse import urlparse

        parsed = urlparse(value)
        if parsed.scheme not in {"ws", "wss"} or not parsed.hostname or parsed.username:
            raise ValueError("Use a ws:// or wss:// bridge address without embedded credentials.")
        return value

    @field_validator("topic")
    @classmethod
    def topic_name(cls, value):
        if not re.fullmatch(r"/(?:[A-Za-z_][A-Za-z0-9_]*/)*[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError("Use an absolute ROS topic such as /physical_shazam/events.")
        return value


class Service:
    def __init__(self, directory, encoder):
        self.directory = directory
        self.encoder = encoder
        self.store = CueStore(directory, encoder.name)
        self.staging = {}
        self.jobs = {}
        self.lock = threading.RLock()
        self.live = False
        self.model_status = "loading"
        self.model_error = None
        self.inference_ms = None
        self.frames = 0
        self.events = deque(maxlen=100)
        log_path = directory / "events.jsonl"
        if log_path.exists():
            with log_path.open() as file:
                for line in deque(file, maxlen=100):
                    try:
                        self.events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        config_path = directory / "ros.json"
        config = (
            RosConfig.model_validate_json(config_path.read_text()).model_dump()
            if config_path.exists()
            else RosConfig().model_dump()
        )
        self.ros = RosPublisher(config)

    def warm(self):
        try:
            self.encoder.load()
            self.encoder.embed(np.zeros(WINDOW, dtype=np.float32))
            self.model_status, self.model_error = "ready", None
        except Exception as exc:
            self.model_status = "error"
            self.model_error = f"Could not load YAMNet ({type(exc).__name__}). Check server logs and internet access."
            import logging

            logging.getLogger(__name__).exception("YAMNet initialization failed")

    def require_model(self):
        if self.model_status != "ready":
            raise HTTPException(503, self.model_error or "YAMNet is loading. Please wait a moment.")

    def examples(self, tokens):
        with self.lock:
            self.staging = {
                key: value
                for key, value in self.staging.items()
                if time.monotonic() - value["created"] < 3600
            }
            try:
                return [self.staging[token] for token in tokens]
            except KeyError as exc:
                raise HTTPException(404, "An example expired. Record or upload it again.") from exc

    def status(self):
        with self.lock:
            events = list(reversed(self.events))
        teacher_config = teacher.settings()
        return {
            "encoder": self.encoder.name,
            "model_status": self.model_status,
            "model_error": self.model_error,
            "sample_rate": SAMPLE_RATE,
            "window_ms": WINDOW / 16,
            "hop_ms": HOP / 16,
            "inference_ms": self.inference_ms,
            "frames": self.frames,
            "listening": self.live,
            "background_calibrated": self.store.background is not None,
            "teacher": {
                "configured": bool(teacher_config["key"]),
                "model": teacher_config["model"],
            },
            "ros": self.ros.snapshot(),
            "cues": [self.store.public(cue) for cue in self.store.snapshot()],
            "events": events,
        }

    def frame(self, detector, offset, samples, publish=True):
        started = time.perf_counter()
        embedding = self.encoder.embed(samples)
        scores, events = detector.score(embedding, offset + WINDOW / SAMPLE_RATE, rms_db(samples))
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        if publish:
            self.inference_ms = elapsed
            self.frames += 1
            with self.lock:
                for event in events:
                    event["ros_delivery"] = self.ros.publish(event)
                    with (self.directory / "events.jsonl").open("a") as file:
                        file.write(json.dumps(event) + "\n")
                    self.events.append(event)
        return {
            "type": "frame",
            "scores": scores,
            "events": events,
            "level_db": round(rms_db(samples), 1),
            "inference_ms": elapsed,
            "stream_seconds": round(offset + WINDOW / SAMPLE_RATE, 2),
        }


def create_app(directory=None, encoder=None):
    directory = Path(directory or os.getenv("PHYSICAL_SHAZAM_DATA", "data"))
    service = Service(directory, encoder or YamnetEncoder())

    @asynccontextmanager
    async def lifespan(app):
        warmup = asyncio.create_task(run_in_threadpool(service.warm))
        yield
        await run_in_threadpool(service.ros.close)
        if not warmup.done():
            warmup.cancel()

    app = FastAPI(title="Physical Shazam", version="0.1.0", lifespan=lifespan)
    app.state.service = service

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin != str(request.base_url).rstrip("/"):
            return JSONResponse({"detail": "Use the dashboard served by this application."}, 403)
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def value_error(request, exc):
        return JSONResponse({"detail": str(exc)}, 400)

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/status")
    def status():
        return service.status()

    @app.post("/api/model/retry")
    def retry_model():
        if service.model_status == "error":
            service.model_status = "loading"
            threading.Thread(target=service.warm, daemon=True).start()
        return {"status": service.model_status}

    def read_upload(file):
        data = file.file.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Upload at most 12 MB per clip.")
        return decode(data)

    @app.post("/api/examples")
    def upload_example(file: Annotated[UploadFile, File()]):
        service.require_model()
        samples = read_upload(file)
        validate_example(samples)
        embedding = service.encoder.embed(samples)
        token = uuid.uuid4().hex
        with service.lock:
            service.examples([])  # Expire abandoned enrollment sessions.
            if len(service.staging) >= 64:
                raise HTTPException(
                    409, "Too many pending examples. Reload in an hour or restart the server."
                )
            service.staging[token] = {
                "samples": samples,
                "embedding": embedding,
                "created": time.monotonic(),
            }
        return {
            "token": token,
            "duration": round(len(samples) / SAMPLE_RATE, 2),
            "level_db": round(rms_db(samples), 1),
        }

    @app.get("/api/examples/{token}/audio")
    def example_audio(token: str):
        return Response(wav_bytes(service.examples([token])[0]["samples"]), media_type="audio/wav")

    @app.delete("/api/examples/{token}")
    def delete_example(token: str):
        with service.lock:
            service.staging.pop(token, None)
        return {"ok": True}

    @app.post("/api/teacher", status_code=202)
    def start_teacher(request: TeacherRequest):
        examples = service.examples(request.examples)
        if not teacher.settings()["key"]:
            raise HTTPException(
                409, "Add GEMINI_API_KEY to .env, then try again. No restart needed."
            )
        job_id = uuid.uuid4().hex
        with service.lock:
            if any(job["status"] == "running" for job in service.jobs.values()):
                raise HTTPException(409, "A Gemini assessment is already running.")
            if len(service.jobs) >= 64:
                service.jobs = {
                    key: job for key, job in service.jobs.items() if job["status"] == "running"
                }
            service.jobs[job_id] = {"status": "running", "examples": request.examples}

        def work():
            try:
                result = teacher.analyze([example["samples"] for example in examples], request.name)
                service.jobs[job_id] = {
                    "status": "done",
                    "result": result,
                    "examples": request.examples,
                }
            except ValueError as exc:
                service.jobs[job_id] = {"status": "error", "error": str(exc)}

        threading.Thread(target=work, daemon=True, name="gemini-teacher").start()
        return {"id": job_id, "status": "running"}

    @app.get("/api/teacher/{job_id}")
    def get_teacher(job_id: str):
        if job_id not in service.jobs:
            raise HTTPException(404, "Assessment not found.")
        return service.jobs[job_id]

    @app.post("/api/cues", status_code=201)
    def enroll(request: Enrollment):
        service.require_model()
        if len(set(request.examples)) != len(request.examples):
            raise ValueError("Each example must be a different recording.")
        examples = service.examples(request.examples)
        cue = service.store.add(
            request.name, [item["embedding"] for item in examples], request.threshold
        )
        folder = directory / "examples" / cue["id"]
        folder.mkdir(parents=True, exist_ok=True)
        try:
            for i, example in enumerate(examples):
                (folder / f"{i + 1}.wav").write_bytes(wav_bytes(example["samples"]))
            job = service.jobs.get(request.teacher_job, {})
            if job.get("status") == "done" and set(job.get("examples", [])) == set(
                request.examples
            ):
                cue = service.store.update(cue["id"], {"teacher": job["result"]})
        except OSError:
            service.store.delete(cue["id"])
            shutil.rmtree(folder, ignore_errors=True)
            raise
        with service.lock:
            for token in request.examples:
                service.staging.pop(token, None)
        return cue

    @app.patch("/api/cues/{cue_id}")
    def update_cue(cue_id: str, request: CueUpdate):
        changes = request.model_dump(exclude_none=True)
        if "name" in changes:
            changes["name"] = changes["name"].strip()
            if not changes["name"]:
                raise ValueError("Give this sound a name.")
        try:
            return service.store.update(cue_id, changes)
        except KeyError:
            raise HTTPException(404, "Cue not found.") from None

    @app.delete("/api/cues/{cue_id}")
    def delete_cue(cue_id: str):
        try:
            service.store.delete(cue_id)
            shutil.rmtree(directory / "examples" / cue_id, ignore_errors=True)
        except KeyError:
            raise HTTPException(404, "Cue not found.") from None
        return {"ok": True}

    @app.get("/api/cues/{cue_id}/audio/{index}")
    def cue_audio(cue_id: str, index: int):
        with service.store.lock:
            cue = service.store.cues.get(cue_id)
            if cue is None or not 1 <= index <= cue["examples"]:
                raise HTTPException(404, "Example not found.")
        return FileResponse(
            directory / "examples" / cue_id / f"{index}.wav", media_type="audio/wav"
        )

    @app.post("/api/background")
    def calibrate(file: Annotated[UploadFile, File()]):
        service.require_model()
        samples = read_upload(file)
        if len(samples) < SAMPLE_RATE * 3:
            raise ValueError("Record at least 3 seconds of the room without the target cue.")
        service.store.calibrate(service.encoder.embed(samples))
        return {"ok": True}

    @app.delete("/api/background")
    def clear_background():
        with service.store.lock:
            service.store.background = None
            service.store.save()
        return {"ok": True}

    @app.post("/api/test")
    def test_recording(file: Annotated[UploadFile, File()]):
        service.require_model()
        samples = read_upload(file)
        if len(samples) < WINDOW:
            raise ValueError("Test with a recording at least one second long.")
        detector, buffer = Detector(service.store), WindowBuffer()
        frames = [
            service.frame(detector, offset, window, publish=False)
            for offset, window in buffer.push(samples)
        ]
        return {
            "frames": frames,
            "events": [event for frame in frames for event in frame["events"]],
            "duration": len(samples) / SAMPLE_RATE,
            "published": False,
        }

    @app.put("/api/ros")
    def configure_ros(request: RosConfig):
        config = request.model_dump()
        temporary = directory / "ros.tmp"
        temporary.write_text(json.dumps(config, indent=2))
        temporary.replace(directory / "ros.json")
        service.ros.configure(config)
        return service.ros.snapshot()

    @app.post("/api/ros/test")
    def test_ros():
        event = {
            "type": "connection.test",
            "name": "Bridge connection test",
            "test": True,
            "id": uuid.uuid4().hex,
        }
        return {"delivery": service.ros.publish(event)}

    @app.websocket("/api/listen")
    async def listen(socket: WebSocket):
        origin = socket.headers.get("origin")
        expected = (
            f"{'https' if socket.url.scheme == 'wss' else 'http'}://{socket.headers.get('host')}"
        )
        if origin and origin != expected:
            await socket.close(code=1008, reason="Open the local dashboard.")
            return
        await socket.accept()
        if service.live or service.model_status != "ready":
            await socket.send_json(
                {
                    "type": "error",
                    "message": "Another session is listening, or YAMNet is not ready.",
                }
            )
            await socket.close()
            return
        service.live = True
        buffer, detector = WindowBuffer(), Detector(service.store)
        try:
            config = await asyncio.wait_for(socket.receive_json(), timeout=10)
            rate = config.get("sample_rate", 0)
            if not isinstance(rate, int) or not 8_000 <= rate <= 192_000:
                raise ValueError("Unsupported microphone sample rate.")
            await socket.send_json({"type": "ready", "sample_rate": SAMPLE_RATE})
            while True:
                data = await asyncio.wait_for(socket.receive_bytes(), timeout=10)
                if len(data) % 4 or not 0 < len(data) <= rate * 4:
                    raise ValueError("Send at most one second of float32 PCM per message.")
                samples = prepare(np.frombuffer(data, dtype="<f4"), rate)
                for offset, window in buffer.push(samples):
                    frame = await run_in_threadpool(service.frame, detector, offset, window)
                    await socket.send_json(frame)
                await socket.send_json({"type": "ack"})
        except WebSocketDisconnect:
            pass
        except (TimeoutError, ValueError) as exc:
            await socket.send_json(
                {"type": "error", "message": str(exc) or "Microphone timed out."}
            )
            await socket.close(code=1008)
        finally:
            service.live = False

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
