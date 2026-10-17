"""Non-blocking rosbridge publisher. Failed/offline events are never replayed later."""

import json
import queue
import threading
import time

from websockets.sync.client import connect


class RosPublisher:
    def __init__(self, config=None):
        self.config = config or {
            "enabled": False,
            "url": "ws://localhost:9090",
            "topic": "/physical_shazam/events",
        }
        self.status = "disabled"
        self.error = None
        self.sent = 0
        self.dropped = 0
        self.queue = queue.Queue(maxsize=32)
        self.stop_event = threading.Event()
        self.changed = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True, name="rosbridge-publisher")
        self.thread.start()

    def snapshot(self):
        return {
            **self.config,
            "status": self.status,
            "error": self.error,
            "sent": self.sent,
            "dropped": self.dropped,
        }

    def configure(self, config):
        self.config = dict(config)
        self.status = "connecting" if config["enabled"] else "disabled"
        while True:
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except queue.Empty:
                break
        self.changed.set()

    def publish(self, event):
        if not self.config["enabled"]:
            return "disabled"
        if self.status != "connected":
            self.dropped += 1
            return "offline"
        try:
            self.queue.put_nowait((time.monotonic(), event))
            return "queued"
        except queue.Full:
            self.dropped += 1
            return "queue_full"

    def _run(self):
        while not self.stop_event.is_set():
            self.changed.clear()
            config = dict(self.config)
            if not config["enabled"]:
                self.status = "disabled"
                self.error = None
                self.changed.wait(0.25)
                continue
            self.status = "connecting"
            try:
                with connect(config["url"], open_timeout=2, close_timeout=1) as socket:
                    socket.send(
                        json.dumps(
                            {
                                "op": "advertise",
                                "topic": config["topic"],
                                "type": "std_msgs/msg/String",
                            }
                        )
                    )
                    self.status, self.error = "connected", None
                    while not self.stop_event.is_set() and not self.changed.is_set():
                        try:
                            message = json.loads(socket.recv(timeout=0.01))
                            if message.get("op") == "status" and message.get("level") == "error":
                                raise ValueError(
                                    "rosbridge rejected the topic or message. Check its log."
                                )
                        except TimeoutError:
                            pass
                        try:
                            created, event = self.queue.get(timeout=0.1)
                        except queue.Empty:
                            continue
                        if time.monotonic() - created > 2:
                            self.dropped += 1
                            continue
                        socket.send(
                            json.dumps(
                                {
                                    "op": "publish",
                                    "topic": config["topic"],
                                    "msg": {"data": json.dumps(event)},
                                }
                            )
                        )
                        self.sent += 1
                    socket.send(json.dumps({"op": "unadvertise", "topic": config["topic"]}))
            except Exception:  # noqa: BLE001 - isolate all transport failures from audio inference.
                self.status = "offline"
                self.error = (
                    "Bridge unavailable or rejected a message. Check the address and bridge log."
                )
                # Discard pending commands rather than delivering stale robotic actions on reconnect.
                while True:
                    try:
                        self.queue.get_nowait()
                        self.dropped += 1
                    except queue.Empty:
                        break
                self.changed.wait(2)

    def close(self):
        self.stop_event.set()
        self.changed.set()
        self.thread.join(timeout=4)
