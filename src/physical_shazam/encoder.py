import os
import threading

import numpy as np


def unit(vector):
    vector = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(vector)
    if not np.isfinite(norm) or norm < 1e-10:
        raise ValueError("The encoder produced an empty or invalid embedding.")
    return vector / norm


class YamnetEncoder:
    name = "yamnet-google-1"
    dimensions = 1024

    def __init__(self):
        self._model = None
        self._lock = threading.Lock()

    @property
    def ready(self):
        return self._model is not None

    def load(self):
        with self._lock:
            if self._model is None:
                os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
                os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "2")
                os.environ.setdefault("TF_NUM_INTEROP_THREADS", "2")
                import tensorflow_hub as hub

                self._model = hub.load("https://tfhub.dev/google/yamnet/1")

    def embed(self, samples):
        self.load()
        with self._lock:
            _, embeddings, _ = self._model(np.asarray(samples, dtype=np.float32))
            return unit(embeddings.numpy().mean(axis=0))
