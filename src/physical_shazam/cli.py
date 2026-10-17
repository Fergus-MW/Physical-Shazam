import argparse
import json
import os
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Physical Shazam — learn a sound, listen locally")
    parser.add_argument("--data-dir", default="data", help="Cue and event storage directory")
    commands = parser.add_subparsers(dest="command")
    web = commands.add_parser("serve", help="Start the dashboard")
    web.add_argument("--port", type=int, default=8765)
    web.add_argument("--host", default="127.0.0.1")
    commands.add_parser("download-model", help="Download and warm up the real YAMNet encoder")
    listen = commands.add_parser(
        "listen", help="Headless microphone detector (install --extra mic)"
    )
    listen.add_argument("--device", default=None)
    args = parser.parse_args()
    os.environ["PHYSICAL_SHAZAM_DATA"] = args.data_dir
    if args.command in {None, "serve"}:
        import uvicorn

        from .server import create_app

        uvicorn.run(
            create_app(),
            host=getattr(args, "host", "127.0.0.1"),
            port=getattr(args, "port", 8765),
            ws_max_size=1024 * 1024,
            ws_max_queue=4,
        )
    elif args.command == "download-model":
        import numpy as np

        from .audio import WINDOW
        from .encoder import YamnetEncoder

        encoder = YamnetEncoder()
        encoder.embed(np.zeros(WINDOW, dtype=np.float32))
        print("YAMNet downloaded and ready (1024-dimensional embeddings).")
    elif args.command == "listen":
        import queue

        try:
            import sounddevice as sd
        except ImportError:
            parser.error("Install microphone support: uv sync --extra mic")
        from .audio import SAMPLE_RATE, WINDOW, WindowBuffer, prepare
        from .core import Detector
        from .encoder import YamnetEncoder
        from .server import Service

        service = Service(Path(args.data_dir), YamnetEncoder())
        service.warm()
        service.require_model()
        if not service.store.snapshot():
            parser.error("Enroll a cue in the dashboard first.")
        device = int(args.device) if args.device and args.device.isdigit() else args.device
        rate = int(sd.query_devices(device, "input")["default_samplerate"])
        blocks = queue.Queue(maxsize=4)
        drops = 0

        def callback(indata, frames, clock, status):
            nonlocal drops
            try:
                blocks.put_nowait((indata[:, 0].copy(), bool(status), drops))
            except queue.Full:
                drops += 1

        buffer, detector = WindowBuffer(), Detector(service.store)
        generation = 0
        started = time.monotonic()
        print("Listening locally. Ctrl-C to stop.", flush=True)
        try:
            with sd.InputStream(
                device=device,
                samplerate=rate,
                blocksize=int(rate * 0.48),
                channels=1,
                dtype="float32",
                callback=callback,
            ):
                while True:
                    samples, discontinuity, current = blocks.get(timeout=10)
                    if discontinuity or generation != current:
                        buffer, detector = WindowBuffer(), Detector(service.store)
                        generation = current
                        print("Audio overflow: reset the window buffer.", flush=True)
                    for _, window in buffer.push(prepare(samples, rate)):
                        result = service.frame(
                            detector, time.monotonic() - started - WINDOW / SAMPLE_RATE, window
                        )
                        for event in result["events"]:
                            print(json.dumps(event), flush=True)
        except KeyboardInterrupt:
            pass
        finally:
            service.ros.close()


if __name__ == "__main__":
    main()
