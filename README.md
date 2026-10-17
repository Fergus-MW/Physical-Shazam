# Physical Shazam

A working environmental sound detector with a local Python engine and a dark listening dashboard. Record 1–5 examples of a sound, optionally ask Gemini to assess them, and recognize the cue from a live microphone without sending the live stream to the cloud.

## Run

Python 3.11 is pinned. [uv](https://docs.astral.sh/uv/) manages the environment and lockfile.

```sh
uv sync --all-extras
cp -n .env.example .env
uv run physical-shazam serve
```

Open **http://127.0.0.1:8765**. The server binds to IPv4 loopback. An alternate port is supported with `serve --port 8766`.

The first launch downloads the real Google YAMNet model and warms it up. Later launches use the TensorFlow Hub cache. The dashboard shows initialization errors and a retry button. TensorFlow Hub currently needs the pinned `setuptools<81` compatibility dependency.

Add your key to the ignored local `.env` file:

```dotenv
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-2.5-flash
```

The backend rereads this file for each Gemini request. Credentials are not returned to the browser or included in event data. A Gemini account with access and available quota is required; **Ask Gemini** sends only the selected enrollment examples to Google. No cloud call is made just by starting the listener.

## Try it

1. Click **Or try a lab sample** to load a synthetic two-tone chime, or **Teach a sound** to record/upload your own examples. WAV, FLAC, and OGG files are supported; each clip must be 1–30 seconds and under 12 MB.
2. Click **Ask Gemini** for a suggested label, audible characteristics, confusable sounds, and recording advice. Review the assessment, then add the sound to the library. This step is optional; local enrollment works without cloud access.
3. Click **Start listening** and allow the browser microphone. Use the play button on a cue card to play its saved example through the speakers, or make the real sound nearby. Headphones will prevent the microphone from hearing a played reference.
4. Inspect the live cosine similarities and event journal. **Tune cue** adjusts threshold, consecutive matching frames, and cooldown. Scores are similarities, not probabilities.
5. In **Sound library**, optionally record five seconds of background room tone. A cue must then exceed its threshold **and** beat background similarity by 0.05. Clear or redo calibration when the room changes.
6. **Test a recording** evaluates a file without publishing ROS messages or adding events to the journal. Try `src/physical_shazam/static/samples/two-tone-test.wav` after enrolling the lab chime, and `room-noise.wav` as a negative.

Listening pauses while capturing enrollment or calibration audio and resumes when that dialog closes. Enrollment clips and cue configurations persist; the live stream is not recorded. Use a separate data directory with `physical-shazam --data-dir ./another-workspace serve`.

## ROS 2 output

The Mac publishes through the rosbridge WebSocket protocol, so it does not need `rclpy`. The default topic is `/physical_shazam/events`, with type `std_msgs/msg/String`. The String's `data` field contains structured JSON:

```json
{
  "id": "unique-event-id",
  "type": "cue.detected",
  "cue_id": "learned-cue-id",
  "name": "Front door chime",
  "score": 0.91,
  "timestamp": "2026-10-17T14:00:00+00:00",
  "stream_seconds": 8.175,
  "action": "notify"
}
```

With no ROS system available, start the included local protocol sink in a second terminal:

```sh
uv run python -m physical_shazam.mock_bridge
```

Open **Connections**, enable ROS, enter `ws://127.0.0.1:9090`, and save. **Send test event** sends a separately typed `connection.test` message. Actual live detections appear in the sink terminal as `cue.detected`. This verifies transport and serialization; the sink **does not run a ROS graph**.

On a ROS 2 machine with `rosbridge_suite` installed:

```sh
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
ros2 topic echo /physical_shazam/events std_msgs/msg/String
```

Point the dashboard at that machine's bridge address. The publisher advertises the type before publishing, observes bridge error messages, and reconnects when unavailable. Its bounded queue drops stale/offline events instead of replaying old robot actions after reconnect. `queued` in the journal means handed to the publisher, and `sent` counts WebSocket writes; rosbridge does not acknowledge subscriber receipt. Validate a real subscription with `ros2 topic echo` when hardware is available. No robot movement is commanded by this prototype.

## Engine and scope

- The frozen environmental-audio encoder is [Google YAMNet](https://www.tensorflow.org/hub/tutorials/yamnet), with 1,024-dimensional embeddings. Enrollment averages normalized embeddings into a cue prototype; adding a cue leaves previous prototypes intact.
- The stream is mono 16 kHz PCM. Full 15,600-sample (975 ms) waveforms cover YAMNet's 96 spectrogram frames, advancing every 7,680 samples (480 ms). Each full window is embedded. This implementation does not pretend that independent 480 ms waveforms reproduce overlapping YAMNet embeddings.
- Each cue scores independently by cosine similarity. Defaults are 0.82 similarity, two matching windows, a silence gate at −55 dBFS, a four-second cooldown, and two nonmatching windows to rearm. These are starting values to tune with real positives and hard negatives.
- Gemini runs asynchronously during enrollment. Its assessment is stored with the cue and helps the user review recordings and choose negatives. **Gemini text is not projected into YAMNet's audio-only embedding space and does not train or distill the encoder.**
- Measured inference time is model execution and scoring, not event latency. The input receptive field and debounce mean this is not a sub-100 ms trigger system. Independent cue scores allow multiple events, but overlap robustness still requires empirical testing.
- This prototype implements manual few-shot enrollment, local streaming, background rejection, cloud assessment, persistence, and event transport. Automatic novelty discovery, spatial audition/ODAS, generative augmentation, CLAP text/audio fusion, MCU compilation, and physical robot actions are future work.
- The model is small compared with a foundation model; the Python/TensorFlow runtime is not an MCU deployment. The encoder-independent core can be reused for a lighter runtime later. Raspberry Pi deployment and real household accuracy have not been measured.

The dashboard uses native HTML/CSS/JavaScript and an AudioWorklet, served by FastAPI. There is no frontend build step. Use a current browser with AudioWorklet support. It loads Google Fonts for typography; system fonts work offline. Bind to loopback for local development; this app has no multiuser authentication.

## Headless microphone mode

Enroll in the dashboard first, then stop that server before running the headless engine on the same data directory:

```sh
uv sync --all-extras
uv run physical-shazam listen
# Or select a sounddevice device index/name:
uv run physical-shazam listen --device 0
```

This captures using PortAudio/sounddevice, keeps inference outside the audio callback, writes the same event log, and uses the saved ROS configuration. On Linux, PortAudio may need to be installed through the OS package manager. Run one process per data directory. Headless mode loads cues at startup; live dashboard enrollment updates the dashboard server's detector immediately.

## Verification

```sh
uv run pytest -q
uv run ruff check src tests scripts
node --test tests/audio_worklet.test.mjs
uv run python scripts/smoke_test.py
```

The 15 Python unit/integration tests cover stream boundaries, resampling, cue persistence, independent matches, debounce/rearm/cooldown, silence/background rejection, API errors, a mocked Gemini request, and a real local rosbridge wire exchange. These tests inject an encoder double where recognition accuracy is irrelevant. The Node test verifies that the actual AudioWorklet preserves all PCM samples across chunk boundaries and final recording flush, including stereo downmixing.

`smoke_test.py` separately runs the **real pretrained YAMNet** through enrollment, synthetic streaming positives, a noise negative, persisted detection events, and a WebSocket bridge sink in an isolated temporary workspace. On the development Mac it detected both replayed chimes, rejected the noise fixture, and measured about 3 ms median inference per window. This is a synthetic integration check, not a benchmark of household recall, false accepts/hour, or real ROS delivery. A live Gemini audio assessment was also verified during development.

Stored files are ignored by Git: `data/cues.json`, `data/examples/<cue-id>/*.wav`, `data/events.jsonl`, and `data/ros.json`. Deleting a cue removes its saved examples. `.env` is ignored separately.

API routes and request schemas are available at **http://127.0.0.1:8765/docs**. Implementation references: [YAMNet](https://www.tensorflow.org/hub/tutorials/yamnet), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio), [structured responses](https://ai.google.dev/gemini-api/docs/structured-output), and the [ROS 2 rosbridge protocol](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md).
