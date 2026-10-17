"""Encoder-independent persistence and multi-label event decisions."""

import json
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from .audio import decode
from .encoder import unit

DEFAULT_THRESHOLD = 0.65


def now():
    return datetime.now(UTC).isoformat()


class CueStore:
    def __init__(self, directory: Path, encoder_name, migrate=False):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "cues.json"
        self.lock = threading.RLock()
        self.encoder_name = encoder_name
        self.cues = {}
        self.background = None
        self.pending_migration = None
        self.migration = None
        if self.path.exists():
            document = json.loads(self.path.read_text())
            if document["encoder"] != encoder_name:
                if not migrate:
                    raise ValueError(
                        "Saved cues use a different encoder. Use a separate data directory."
                    )
                self.pending_migration = document
                return
            self.cues = {cue["id"]: cue for cue in document["cues"]}
            self.background = document.get("background")

    def save(self):
        with self.lock:
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "encoder": self.encoder_name,
                        "cues": list(self.cues.values()),
                        "background": self.background,
                    },
                    indent=2,
                )
            )
            temporary.replace(self.path)

    def migrate(self, embed):
        """Re-embed every cue from its saved example audio after an encoder change."""
        with self.lock:
            document = self.pending_migration
            if document is None:
                return None
            backup = self.directory / f"cues.{document['encoder']}.json"
            backup.write_text(json.dumps(document, indent=2))
            cues, skipped = {}, []
            for cue in document["cues"]:
                files = sorted((self.directory / "examples" / cue["id"]).glob("*.wav"))
                if not files:
                    skipped.append(cue["name"])
                    continue
                embeddings = [unit(embed(decode(f.read_bytes()))) for f in files]
                cues[cue["id"]] = {
                    **cue,
                    "threshold": DEFAULT_THRESHOLD,
                    "prototype": unit(np.mean(embeddings, axis=0)).tolist(),
                }
            self.cues = cues
            self.background = None
            self.pending_migration = None
            self.migration = {
                "from": document["encoder"],
                "cues": len(cues),
                "skipped": skipped,
                "backup": backup.name,
            }
            self.save()
            return self.migration

    def add(self, name, embeddings, threshold=DEFAULT_THRESHOLD, action="notify"):
        if not 1 <= len(embeddings) <= 5:
            raise ValueError("Enroll with 1–5 examples.")
        cue = {
            "id": uuid.uuid4().hex,
            "name": name,
            "created_at": now(),
            "examples": len(embeddings),
            "threshold": threshold,
            "enabled": True,
            "action": action,
            "hits": 2,
            "cooldown": 4.0,
            "prototype": unit(np.mean([unit(e) for e in embeddings], axis=0)).tolist(),
        }
        with self.lock:
            self.cues[cue["id"]] = cue
            self.save()
        return self.public(cue)

    @staticmethod
    def public(cue):
        return {key: value for key, value in cue.items() if key != "prototype"}

    def snapshot(self):
        with self.lock:
            return [dict(cue) for cue in self.cues.values()]

    def update(self, cue_id, changes):
        with self.lock:
            if cue_id not in self.cues:
                raise KeyError(cue_id)
            self.cues[cue_id].update(changes)
            self.save()
            return self.public(self.cues[cue_id])

    def delete(self, cue_id):
        with self.lock:
            del self.cues[cue_id]
            self.save()

    def calibrate(self, embedding):
        with self.lock:
            self.background = unit(embedding).tolist()
            self.save()


class Detector:
    def __init__(self, store: CueStore):
        self.store = store
        self.states = {}

    def score(self, embedding, timestamp, db=-20):
        embedding = unit(embedding)
        scores, events = [], []
        background = self.store.background
        background_score = float(np.dot(embedding, background)) if background else -1.0
        for cue in self.store.snapshot():
            state = self.states.setdefault(
                cue["id"], {"count": 0, "active": False, "last": -float("inf"), "misses": 0}
            )
            similarity = float(np.clip(np.dot(embedding, cue["prototype"]), -1, 1))
            matched = (
                cue["enabled"]
                and db > -55
                and similarity >= cue["threshold"]
                and (background is None or similarity >= background_score + 0.05)
            )
            scores.append(
                {"id": cue["id"], "score": round(similarity, 4), "matched": bool(matched)}
            )
            state["count"] = state["count"] + 1 if matched else 0
            state["misses"] = 0 if matched else state["misses"] + 1
            if state["misses"] >= 2:
                state["active"] = False
            if (
                state["count"] >= cue["hits"]
                and not state["active"]
                and timestamp - state["last"] >= cue["cooldown"]
            ):
                state.update(active=True, last=timestamp)
                events.append(
                    {
                        "id": uuid.uuid4().hex,
                        "type": "cue.detected",
                        "cue_id": cue["id"],
                        "name": cue["name"],
                        "score": round(similarity, 4),
                        "timestamp": now(),
                        "stream_seconds": round(timestamp, 3),
                        "action": cue["action"],
                    }
                )
        return scores, events
