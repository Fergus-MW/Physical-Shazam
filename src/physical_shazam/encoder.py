import threading

import numpy as np

SAMPLE_RATE = 16_000
CED_REPOSITORY = "mispeech/ced-small"
CED_REVISION = "06bb40c5ec089e96867ebc5246be02441f4a71e4"


def unit(vector):
    vector = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(vector, axis=-1, keepdims=True)
    if not np.all(np.isfinite(norm)) or np.any(norm < 1e-10):
        raise ValueError("The encoder produced an empty or invalid embedding.")
    return vector / norm


def reference_signals(length=15_600):
    """Deterministic noise, tones, clicks and sweeps used to centre the embedding space."""
    rng = np.random.default_rng(7)
    t = np.arange(length) / SAMPLE_RATE
    signals = []
    for amplitude in (0.01, 0.05, 0.2):
        white = rng.standard_normal(length)
        spectrum = np.fft.rfft(rng.standard_normal(length))
        k = np.arange(1, len(spectrum) + 1)
        clicks = np.zeros(length)
        clicks[::1600] = 1
        group = [
            white,
            np.fft.irfft(spectrum / np.sqrt(k), length),
            np.fft.irfft(spectrum / k, length),
            *(np.sin(2 * np.pi * hz * t) for hz in (220, 440, 1000, 3000)),
            clicks,
            np.sin(2 * np.pi * (200 + 4000 * t) * t),
        ]
        signals += [s / (np.abs(s).max() + 1e-9) * amplitude for s in group]
    return np.stack(signals).astype(np.float32)


class CedEncoder:
    """CED-small (Apache-2.0) audio transformer, mean-pooled and centred.

    Raw CED embeddings share a large common direction, so cosine scores bunch near 1.
    Subtracting the mean embedding of fixed synthetic reference signals spreads them out.
    """

    name = "ced-small-06bb40c-centred"
    dimensions = 384

    def __init__(self, threads=2):
        self._threads = threads
        self._model = None
        self._features = None
        self._centre = None
        self._lock = threading.Lock()

    @property
    def ready(self):
        return self._centre is not None

    def load(self):
        with self._lock:
            if self._model is not None:
                return
            import torch
            from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

            torch.set_num_threads(self._threads)
            options = {"revision": CED_REVISION, "trust_remote_code": True}
            self._features = AutoFeatureExtractor.from_pretrained(CED_REPOSITORY, **options)
            self._model = AutoModelForAudioClassification.from_pretrained(
                CED_REPOSITORY, **options
            ).eval()
            self._centre = unit(self._raw(reference_signals())).mean(axis=0)

    def _raw(self, batch):
        import torch

        with torch.inference_mode():
            inputs = self._features(
                torch.from_numpy(np.atleast_2d(np.asarray(batch, dtype=np.float32))),
                sampling_rate=SAMPLE_RATE,
                return_tensors="pt",
            )
            hidden = self._model.encoder(inputs["input_values"]).logits
            return hidden.mean(dim=1).numpy()

    def embed(self, samples):
        self.load()
        with self._lock:
            return unit(unit(self._raw(samples)[0]) - self._centre)
