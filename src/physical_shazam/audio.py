from io import BytesIO
from math import gcd

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

SAMPLE_RATE = 16_000
WINDOW = 15_600  # 96 mel frames, including the 25 ms STFT analysis window.
HOP = 7_680
MAX_SECONDS = 30


def prepare(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    if samples.ndim != 1 or not len(samples) or not np.isfinite(samples).all():
        raise ValueError("Audio must contain finite, non-empty PCM samples.")
    if not 8_000 <= sample_rate <= 192_000:
        raise ValueError("Supported sample rates are 8–192 kHz.")
    if len(samples) > sample_rate * MAX_SECONDS:
        raise ValueError(f"Audio clips must be at most {MAX_SECONDS} seconds.")
    if sample_rate != SAMPLE_RATE:
        factor = gcd(sample_rate, SAMPLE_RATE)
        samples = resample_poly(samples, SAMPLE_RATE // factor, sample_rate // factor)
    return np.clip(samples, -1, 1).astype(np.float32)


def decode(data: bytes) -> np.ndarray:
    try:
        with sf.SoundFile(BytesIO(data)) as file:
            if file.frames > file.samplerate * MAX_SECONDS:
                raise ValueError(f"Audio clips must be at most {MAX_SECONDS} seconds.")
            rate = file.samplerate
            samples = file.read(dtype="float32", always_2d=True)
    except (sf.LibsndfileError, RuntimeError) as exc:
        raise ValueError("Could not read audio. Upload a WAV, FLAC, or OGG file.") from exc
    return prepare(samples, rate)


def validate_example(samples: np.ndarray) -> None:
    if len(samples) < WINDOW:
        raise ValueError("Record at least one second, with the target sound clearly audible.")
    if rms_db(samples) < -55:
        raise ValueError("This recording is too quiet. Move closer and record the cue again.")


def rms_db(samples: np.ndarray) -> float:
    return float(20 * np.log10(max(float(np.sqrt(np.mean(samples**2))), 1e-8)))


def wav_bytes(samples: np.ndarray) -> bytes:
    buffer = BytesIO()
    sf.write(buffer, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


class WindowBuffer:
    """Keep full receptive fields while advancing on a 480 ms hop grid."""

    def __init__(self):
        self.samples = np.empty(0, dtype=np.float32)
        self.offset = 0

    def push(self, samples):
        self.samples = np.concatenate((self.samples, samples))
        while len(self.samples) >= WINDOW:
            yield self.offset / SAMPLE_RATE, self.samples[:WINDOW].copy()
            self.samples = self.samples[HOP:]
            self.offset += HOP
