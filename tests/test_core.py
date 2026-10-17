import numpy as np

from physical_shazam.audio import HOP, SAMPLE_RATE, WINDOW, WindowBuffer, prepare
from physical_shazam.core import CueStore, Detector


def test_stream_windows_are_independent_of_capture_chunk_sizes():
    samples = np.arange(SAMPLE_RATE * 4, dtype=np.float32)
    expected = list(WindowBuffer().push(samples))
    buffer = WindowBuffer()
    actual = []
    for chunk in np.array_split(samples, 37):
        actual.extend(buffer.push(chunk))
    assert len(actual) == len(expected)
    for (offset, window), (expected_offset, expected_window) in zip(actual, expected, strict=True):
        assert offset == expected_offset
        np.testing.assert_array_equal(window, expected_window)
        assert len(window) == WINDOW
    assert actual[1][0] - actual[0][0] == HOP / SAMPLE_RATE


def test_stereo_input_resamples_without_changing_duration():
    stereo = np.ones((44_100 * 2, 2), dtype=np.float32) * 0.1
    result = prepare(stereo, 44_100)
    assert len(result) == SAMPLE_RATE * 2
    assert result.dtype == np.float32
    np.testing.assert_allclose(result[100:-100], 0.1, atol=0.001)


def test_learning_a_second_cue_preserves_the_first_across_restart(tmp_path):
    store = CueStore(tmp_path, "test")
    first = store.add("Door", [[1, 0, 0]])
    store.add("Kettle", [[0, 1, 0], [0.01, 1, 0]])
    store.calibrate([0, 0, 1])
    restored = CueStore(tmp_path, "test")
    assert len(restored.snapshot()) == 2
    assert restored.cues[first["id"]]["prototype"] == [1, 0, 0]
    assert restored.background == [0, 0, 1]
    assert "prototype" not in restored.public(restored.cues[first["id"]])


def test_detector_rejects_spikes_latches_and_rearms_after_release(tmp_path):
    store = CueStore(tmp_path, "test")
    cue = store.add("Door", [[1, 0]])
    detector = Detector(store)
    assert not detector.score([1, 0], 0)[1]
    assert not detector.score([0, 1], 0.48)[1]  # Isolated spike rejected.
    assert not detector.score([1, 0], 0.96)[1]
    assert len(detector.score([1, 0], 1.44)[1]) == 1
    assert not detector.score([1, 0], 7)[1]  # Held sound does not repeat after cooldown.
    detector.score([0, 1], 7.5)
    detector.score([0, 1], 8)
    detector.score([1, 0], 8.5)
    assert detector.score([1, 0], 9)[1][0]["cue_id"] == cue["id"]


def test_background_silence_and_disabled_cues_cannot_trigger(tmp_path):
    store = CueStore(tmp_path, "test")
    cue = store.add("Hum", [[1, 0]])
    store.update(cue["id"], {"hits": 1})
    store.calibrate([1, 0])
    assert not Detector(store).score([1, 0], 1)[1]
    store.background = None
    assert not Detector(store).score([1, 0], 1, db=-70)[1]
    store.update(cue["id"], {"enabled": False})
    assert not Detector(store).score([1, 0], 1)[1]


def test_scores_are_independent_not_winner_take_all(tmp_path):
    store = CueStore(tmp_path, "test")
    for name in ["Door", "Bell"]:
        cue = store.add(name, [[1, 0]])
        store.update(cue["id"], {"hits": 1})
    _, events = Detector(store).score([1, 0], 1)
    assert {event["name"] for event in events} == {"Door", "Bell"}


def test_cooldown_blocks_another_event_after_the_detector_rearms(tmp_path):
    store = CueStore(tmp_path, "test")
    cue = store.add("Door", [[1, 0]])
    store.update(cue["id"], {"hits": 1, "cooldown": 4})
    detector = Detector(store)
    assert len(detector.score([1, 0], 1)[1]) == 1
    detector.score([0, 1], 1.5)
    detector.score([0, 1], 2)
    assert not detector.score([1, 0], 2.5)[1]
    assert not detector.score([1, 0], 4.9)[1]
    assert len(detector.score([1, 0], 5)[1]) == 1


def test_encoder_change_reembeds_saved_examples(tmp_path):
    import json

    import pytest

    from physical_shazam.audio import SAMPLE_RATE, wav_bytes
    from physical_shazam.core import DEFAULT_THRESHOLD

    old = CueStore(tmp_path, "old-encoder")
    cue = old.add("Chime", [np.array([1.0, 0.0])], threshold=0.9)
    old.calibrate(np.array([0.0, 1.0]))
    folder = tmp_path / "examples" / cue["id"]
    folder.mkdir(parents=True)
    tone = np.sin(np.arange(SAMPLE_RATE) / 5).astype(np.float32) * 0.3
    (folder / "1.wav").write_bytes(wav_bytes(tone))

    with pytest.raises(ValueError):
        CueStore(tmp_path, "new-encoder")
    store = CueStore(tmp_path, "new-encoder", migrate=True)
    assert store.pending_migration is not None and not store.snapshot()
    calls = []
    result = store.migrate(lambda samples: calls.append(len(samples)) or np.array([0.0, 2.0, 0.0]))

    assert calls == [SAMPLE_RATE]
    assert result == {
        "from": "old-encoder",
        "cues": 1,
        "skipped": [],
        "backup": "cues.old-encoder.json",
    }
    restored = CueStore(tmp_path, "new-encoder")
    [migrated] = restored.snapshot()
    assert migrated["id"] == cue["id"] and migrated["name"] == "Chime"
    assert migrated["prototype"] == [0.0, 1.0, 0.0]
    assert migrated["threshold"] == DEFAULT_THRESHOLD
    assert restored.background is None
    assert json.loads((tmp_path / "cues.old-encoder.json").read_text())["encoder"] == "old-encoder"
