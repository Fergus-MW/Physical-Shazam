"""Local wire-protocol sink; does not run or emulate a ROS graph."""

import argparse
import json

from websockets.sync.server import serve


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9090)
    args = parser.parse_args()

    def handle(socket):
        topics = set()
        for raw in socket:
            message = json.loads(raw)
            if message.get("op") == "advertise":
                topics.add(message["topic"])
                print(f"ADVERTISE {message['topic']} ({message['type']})", flush=True)
            elif message.get("op") == "publish" and message.get("topic") in topics:
                print(
                    json.dumps(
                        {
                            "mock": True,
                            "topic": message["topic"],
                            "event": json.loads(message["msg"]["data"]),
                        }
                    ),
                    flush=True,
                )
            elif message.get("op") == "unadvertise":
                topics.discard(message["topic"])
            else:
                socket.send(
                    json.dumps(
                        {
                            "op": "status",
                            "level": "error",
                            "msg": "Advertise the topic before publishing.",
                        }
                    )
                )

    print(f"MOCK rosbridge sink on ws://localhost:{args.port} — no ROS graph", flush=True)
    with serve(handle, "127.0.0.1", args.port) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
