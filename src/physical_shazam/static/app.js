import { SystemDiagram } from "/static/diagram.js";

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let status = null,
  page = "station",
  socket = null,
  microphone = null,
  recording = false;
let recordFinish = null,
  listenPending = false,
  resumeListening = false,
  cueVersion = "",
  eventVersion = "";
let examples = [],
  teacherJob = null,
  teacherPending = false,
  enrollmentGeneration = 0,
  editingCue = null,
  exampleUploading = 0,
  enrollmentSaving = false,
  calibrationGeneration = 0;
let waveformSamples = new Float32Array(200),
  streamSeconds = 0,
  ackPending = false;
let toastTimer,
  statusBusy = false,
  latestScores = new Map();
let referenceAudio = null;

async function api(path, { method = "GET", body, ...options } = {}) {
  const init = { method, ...options };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const response = await fetch(path, init);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Server returned HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const detail = Array.isArray(result.detail)
      ? result.detail.map((e) => e.msg).join(" · ")
      : result.detail;
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  return result;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 5500);
}
function errorIn(id, message) {
  $(id).textContent = message;
  $(id).classList.toggle("hidden", !message);
}
function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function switchPage(next) {
  page = next;
  const names = {
    station: ["Listening station", "A familiar sound. A new possibility."],
    library: ["Sound library", "The everyday sounds you want to know about."],
    journal: [
      "Event journal",
      "A record of the moments your listener recognized.",
    ],
  };
  for (const p of Object.keys(names))
    $(`${p}-page`).classList.toggle("hidden", p !== page);
  document
    .querySelectorAll("[data-page]")
    .forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("page-title").textContent = names[page][0];
  $("breadcrumb-current").textContent = names[page][0];
  $("page-description").textContent = names[page][1];
  document.title = `Physical Shazam · ${names[page][0]}`;
}
document
  .querySelectorAll("[data-page]")
  .forEach((el) =>
    el.addEventListener("click", () => switchPage(el.dataset.page)),
  );
document
  .querySelectorAll("[data-open-page]")
  .forEach((el) =>
    el.addEventListener("click", () => switchPage(el.dataset.openPage)),
  );

function emptyLibrary() {
  return `<div class="empty-library"><div class="empty-library-main"><span class="empty-symbol">${icon("wave")}</span><div><h3>Your first sound starts here.</h3><p>Teach your listener a sound that matters to you.<br>A few clear examples are all it takes to begin.</p></div></div><div class="empty-actions"><button class="button primary" data-teach>${icon("plus")}Teach a sound</button><button class="text-button" data-sample>Or try a lab sample ${icon("arrow")}</button></div></div>`;
}
function cueCard(cue) {
  return `<article class="cue-card ${cue.enabled ? "" : "disabled"}" data-cue="${cue.id}"><div class="cue-card-top"><span class="cue-icon">${icon("bell")}</span><div class="cue-card-controls"><button class="icon-button" data-play="${cue.id}" aria-label="Play example of ${esc(cue.name)}" title="Play the first saved example">${icon("play")}</button><label class="switch"><input type="checkbox" ${cue.enabled ? "checked" : ""} data-enable="${cue.id}" aria-label="Enable ${esc(cue.name)}"><span></span></label></div></div><h3>${esc(cue.name)}</h3><div class="cue-meta">${cue.examples} EXAMPLE${cue.examples === 1 ? "" : "S"} · ${cue.teacher ? "GEMINI REVIEWED" : "AUDIO PROTOTYPE"}</div><div class="cue-score-row"><span>Live similarity</span><output data-score="${cue.id}">—</output></div><div class="score-track"><div class="score-fill" data-fill="${cue.id}"></div><span class="score-threshold" style="left:${cue.threshold * 100}%" title="Threshold ${cue.threshold.toFixed(2)}"></span></div><div class="cue-card-bottom"><span>THRESHOLD ${cue.threshold.toFixed(2)}</span><button class="text-button" data-edit="${cue.id}">${icon("sliders")}Tune cue</button></div></article>`;
}
function renderCues() {
  const cues = status?.cues || [];
  $("station-cues").innerHTML = cues.length
    ? cues.slice(0, 3).map(cueCard).join("")
    : emptyLibrary();
  $("library-cues").innerHTML = cues.length
    ? cues.map(cueCard).join("")
    : emptyLibrary();
  $("nav-count").textContent = cues.length;
  $("cue-count").textContent = String(cues.length).padStart(2, "0");
  $("library-summary").textContent =
    `${cues.length} learned sound${cues.length === 1 ? "" : "s"} · ${cues.filter((c) => c.enabled).length} active`;
  document
    .querySelectorAll("[data-teach]")
    .forEach((el) => (el.onclick = () => openEnrollment()));
  document
    .querySelectorAll("[data-sample]")
    .forEach((el) => (el.onclick = () => trySample()));
  document.querySelectorAll("[data-enable]").forEach(
    (el) =>
      (el.onchange = async () => {
        try {
          await api(`/api/cues/${el.dataset.enable}`, {
            method: "PATCH",
            body: { enabled: el.checked },
          });
          await refresh();
        } catch (error) {
          toast(error.message);
          el.checked = !el.checked;
        }
      }),
  );
  document
    .querySelectorAll("[data-edit]")
    .forEach((el) => (el.onclick = () => openCue(el.dataset.edit)));
  document.querySelectorAll("[data-play]").forEach(
    (el) =>
      (el.onclick = async () => {
        referenceAudio?.pause();
        referenceAudio = new Audio(`/api/cues/${el.dataset.play}/audio/1`);
        try {
          await referenceAudio.play();
        } catch {
          toast("Could not play this example. Check your audio output.");
        }
      }),
  );
  updateScores(latestScores);
}
function eventRows(events) {
  if (!events.length)
    return `<div class="empty-events">${icon("clock")}<div>Nothing heard just yet.<small>Recognized sounds will appear here as they happen.</small></div></div>`;
  return events
    .map(
      (event) =>
        `<div class="event-row"><span class="event-icon">${icon("check")}</span><div class="event-name">${esc(event.name)}<small>${esc(new Date(event.timestamp).toLocaleDateString())} · ${timeLabel(event.timestamp)}</small></div><span class="event-score">${Number(event.score).toFixed(3)}</span><span class="event-output">${esc({ queued: "ROS queued", offline: "ROS offline", disabled: "Local event", queue_full: "ROS full" }[event.ros_delivery] || "Local event")}</span><span class="event-time">${timeLabel(event.timestamp)}</span></div>`,
    )
    .join("");
}
function renderEvents() {
  $("recent-events").innerHTML = eventRows((status?.events || []).slice(0, 4));
  $("journal-events").innerHTML = eventRows(status?.events || []);
}
function updateScores(scores) {
  for (const [id, score] of scores) {
    document
      .querySelectorAll(`[data-score="${id}"]`)
      .forEach((el) => (el.textContent = score.toFixed(3)));
    document
      .querySelectorAll(`[data-fill="${id}"]`)
      .forEach((el) => (el.style.width = `${Math.max(0, score) * 100}%`));
  }
}
async function refresh() {
  if (statusBusy) return;
  statusBusy = true;
  try {
    status = await api("/api/status");
    const ready = status.model_status === "ready";
    $("listen-button").disabled = (!ready || listenPending) && !socket;
    document
      .querySelectorAll(".teach-button")
      .forEach((el) => (el.disabled = !ready));
    $("gemini-config-status").textContent = status.teacher.configured
      ? `Key configured · ${status.teacher.model}`
      : "API key not configured";
    $("ros-config-status").textContent =
      `${status.ros.status.charAt(0).toUpperCase() + status.ros.status.slice(1)} · ${status.ros.sent} messages sent${status.ros.dropped ? ` · ${status.ros.dropped} dropped` : ""}`;
    updateDiagram();
    if (status.model_status === "error") {
      $("notice").innerHTML =
        `${esc(status.model_error)} <button class="text-button" id="retry-model">Retry model download →</button>`;
      $("notice").className = "notice error";
      $("retry-model").onclick = async () => {
        await api("/api/model/retry", { method: "POST" });
        await refresh();
      };
    } else if (!ready) {
      $("notice").textContent =
        "Preparing the local audio encoder. The first launch downloads YAMNet; following launches use the cached model.";
      $("notice").className = "notice";
    } else $("notice").className = "notice hidden";
    const nextCues = JSON.stringify(status.cues);
    if (nextCues !== cueVersion) {
      cueVersion = nextCues;
      renderCues();
    }
    const nextEvents = JSON.stringify(status.events.map((e) => e.id));
    if (nextEvents !== eventVersion) {
      eventVersion = nextEvents;
      renderEvents();
    }
  } catch (error) {
    $("notice").textContent =
      "The local server is unavailable. Start it with uv run physical-shazam serve.";
    $("notice").className = "notice error";
    $("listen-button").disabled = true;
  } finally {
    statusBusy = false;
  }
}

async function createMicrophone(onChunk) {
  if (microphone)
    throw new Error(
      "The microphone is already in use. Finish recording first.",
    );
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Microphone access needs localhost or HTTPS in a supported browser.",
    );
  let stream, context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    context = new AudioContext();
    await context.audioWorklet.addModule("/static/capture-processor.js");
    await context.resume();
    const source = context.createMediaStreamSource(stream),
      node = new AudioWorkletNode(context, "pcm-capture");
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    let flushDone = null;
    node.port.onmessage = ({ data }) => {
      if (data === "flushed") {
        flushDone?.();
        return;
      }
      waveformSamples = data;
      let sum = 0;
      for (const sample of data) sum += sample * sample;
      $("input-level").textContent =
        `${Math.max(-99, 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-8)).toFixed(1)} dBFS`;
      onChunk(data, context.sampleRate);
    };
    const mic = {
      stream,
      context,
      rate: context.sampleRate,
      async close() {
        await Promise.race([
          new Promise((resolve) => {
            flushDone = resolve;
            node.port.postMessage("flush");
          }),
          new Promise((resolve) => setTimeout(resolve, 400)),
        ]);
        stream.getTracks().forEach((track) => track.stop());
        node.disconnect();
        source.disconnect();
        mute.disconnect();
        await context.close();
        if (microphone === mic) microphone = null;
      },
    };
    microphone = mic;
    const name = stream.getAudioTracks()[0].label || "System microphone";
    $("mic-name").innerHTML =
      `${esc(name.length > 31 ? name.slice(0, 28) + "…" : name)}<small>16 kHz processing · 480 ms hop</small>`;
    return mic;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    await context?.close();
    throw new Error(
      error.name === "NotAllowedError"
        ? "Microphone access was declined. Enable it in your browser’s site settings, then try again."
        : error.message,
    );
  }
}
function setListening(active) {
  live.frames = 0;
  live.inferenceMs = null;
  $("listen-status").className = `status-pill ${active ? "listening" : ""}`;
  $("listen-status").innerHTML = `<i></i>${active ? "Listening" : "Standby"}`;
  $("waveform-idle").classList.toggle("hidden", active);
  $("listen-button").innerHTML =
    `${icon(active ? "wave" : "play")}<span>${active ? "Stop listening" : "Start listening"}</span>`;
  if (!active) {
    waveformSamples = new Float32Array(200);
    $("input-level").textContent = "— dBFS";
  }
}
async function stopListening() {
  const currentSocket = socket;
  socket = null;
  ackPending = false;
  if (currentSocket) {
    currentSocket.onclose = null;
    currentSocket.close();
  }
  if (microphone && !recording) await microphone.close();
  setListening(false);
  latestScores = new Map();
  document
    .querySelectorAll("[data-score]")
    .forEach((el) => (el.textContent = "—"));
  document
    .querySelectorAll("[data-fill]")
    .forEach((el) => (el.style.width = "0"));
  await refresh();
}
async function startListening() {
  if (listenPending || socket) return;
  listenPending = true;
  $("listen-button").disabled = true;
  try {
    if (status?.model_status !== "ready")
      throw new Error("Wait for the local encoder to finish loading.");
    let ws = null,
      streamReady = false;
    // Ask for permission before opening the server's timed handshake.
    const mic = await createMicrophone((chunk) => {
      if (!streamReady || ws?.readyState !== WebSocket.OPEN || socket !== ws)
        return;
      if (ackPending || ws.bufferedAmount > 256000) {
        toast(
          "Inference could not keep up with the microphone. Listening stopped; no audio was silently skipped.",
        );
        streamReady = false;
        stopListening();
        return;
      }
      ackPending = true;
      ws.send(chunk.buffer);
      diagram.send(["mic", "window"], performance.now(), { duration: 300 });
    });
    ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/listen`,
    );
    ws.binaryType = "arraybuffer";
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () =>
        reject(new Error("Could not open the local audio connection."));
    });
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    ready.catch(() => {});
    ws.onclose = () => {
      readyReject(new Error("Audio connection closed during setup."));
      streamReady = false;
      if (socket === ws) {
        toast("Audio connection closed. Start listening again when ready.");
        stopListening();
      }
    };
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "ready") readyResolve();
      else if (message.type === "error") {
        readyReject(new Error(message.message));
        toast(message.message);
        stopListening();
      } else if (message.type === "ack") ackPending = false;
      else if (message.type === "frame") {
        streamSeconds = message.stream_seconds;
        latestScores = new Map(
          message.scores.map((item) => [item.id, item.score]),
        );
        updateScores(latestScores);
        live.inferenceMs = message.inference_ms;
        live.frames += 1;
        live.level = message.level_db;
        const now = performance.now();
        diagram.send(["window", "encoder", "match"], now, { duration: 260 });
        for (const event of message.events) {
          live.lastEvent = event;
          const route = ["match", "event", "journal"];
          diagram.send(route, now + 520, { duration: 300, kind: "event" });
          if (event.ros_delivery === "queued")
            diagram.send(["event", "ros"], now + 820, { duration: 320, kind: "event" });
        }
        updateDiagram();
        for (const event of message.events) {
          document
            .querySelectorAll(`[data-cue="${event.cue_id}"]`)
            .forEach((el) => {
              el.classList.add("detected");
              setTimeout(() => el.classList.remove("detected"), 1700);
            });
          toast(`Heard: ${event.name} · similarity ${event.score.toFixed(3)}`);
        }
        if (message.events.length) refresh();
      }
    };
    ws.send(JSON.stringify({ sample_rate: mic.rate }));
    await Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Listener handshake timed out.")),
          5000,
        ),
      ),
    ]);
    streamReady = true;
    setListening(true);
    streamSeconds = 0;
  } catch (error) {
    await stopListening();
    toast(error.message);
  } finally {
    listenPending = false;
    $("listen-button").disabled = false;
  }
}
$("listen-button").onclick = () =>
  socket ? stopListening() : startListening();

function wavBlob(chunks, rate) {
  const length = chunks.reduce((n, c) => n + c.length, 0),
    buffer = new ArrayBuffer(44 + length * 2),
    view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const s = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
      offset += 2;
    }
  return new Blob([buffer], { type: "audio/wav" });
}
async function recordClip(seconds, progress, isCurrent = () => true) {
  if (recording) throw new Error("A recording is already in progress.");
  recording = true;
  const chunks = [];
  let mic;
  try {
    mic = await createMicrophone((chunk) => chunks.push(chunk));
    if (!isCurrent()) return null;
    await new Promise((resolve) => {
      const started = performance.now();
      const interval = setInterval(
        () =>
          progress?.(
            Math.max(0, seconds - (performance.now() - started) / 1000),
          ),
        100,
      );
      const timer = setTimeout(finish, seconds * 1000);
      function finish() {
        clearTimeout(timer);
        clearInterval(interval);
        recordFinish = null;
        resolve();
      }
      recordFinish = finish;
    });
    await mic.close();
    return wavBlob(chunks, mic.rate);
  } finally {
    if (microphone === mic) await mic.close();
    recording = false;
    recordFinish = null;
    waveformSamples = new Float32Array(200);
  }
}
async function uploadExample(file, generation = enrollmentGeneration) {
  if (generation !== enrollmentGeneration || !$("enroll-dialog").open)
    return false;
  if (teacherPending || enrollmentSaving)
    throw new Error("Wait for the current enrollment operation to finish.");
  if (examples.length + exampleUploading >= 5)
    throw new Error("Five examples is the enrollment limit.");
  if (file.size > 12 * 1024 * 1024)
    throw new Error("Each audio file must be under 12 MB.");
  const form = new FormData();
  form.append("file", file, "example.wav");
  exampleUploading++;
  renderExamples();
  try {
    const example = await api("/api/examples", { method: "POST", body: form });
    if (generation !== enrollmentGeneration || !$("enroll-dialog").open) {
      await api(`/api/examples/${example.token}`, { method: "DELETE" }).catch(
        () => {},
      );
      return false;
    }
    examples.push(example);
    teacherJob = null;
    $("teacher-result").classList.add("hidden");
    $("ask-teacher").innerHTML = `Ask Gemini${icon("arrow")}`;
    return true;
  } finally {
    if (generation === enrollmentGeneration) {
      exampleUploading--;
      renderExamples();
    }
  }
}
function renderExamples() {
  $("example-count").textContent = `${examples.length} / 5`;
  $("example-list").innerHTML = examples
    .map(
      (example, i) =>
        `<div class="example-row"><span class="example-check">${icon("check")}</span><span>Example ${i + 1}<br><small>${example.duration.toFixed(1)}s · ${example.level_db} dBFS</small></span><audio controls preload="none" src="/api/examples/${example.token}/audio" aria-label="Play example ${i + 1}"></audio><button type="button" class="icon-button" data-remove="${example.token}" aria-label="Remove example ${i + 1}" ${teacherPending || enrollmentSaving || exampleUploading || recording ? "disabled" : ""}>${icon("close")}</button></div>`,
    )
    .join("");
  document.querySelectorAll("[data-remove]").forEach(
    (el) =>
      (el.onclick = async () => {
        const generation = enrollmentGeneration;
        try {
          await api(`/api/examples/${el.dataset.remove}`, { method: "DELETE" });
          if (generation !== enrollmentGeneration) return;
          examples = examples.filter((e) => e.token !== el.dataset.remove);
          teacherJob = null;
          $("teacher-result").classList.add("hidden");
          $("ask-teacher").innerHTML = `Ask Gemini${icon("arrow")}`;
          renderExamples();
        } catch (error) {
          if (generation === enrollmentGeneration)
            errorIn("enroll-error", error.message);
        }
      }),
  );
  const busy = exampleUploading > 0 || teacherPending || enrollmentSaving;
  $("record-button").disabled = examples.length >= 5 || busy;
  $("upload-button").disabled = examples.length >= 5 || busy || recording;
  $("ask-teacher").disabled = !examples.length || busy || recording;
  $("save-cue").disabled = !examples.length || busy || recording;
  $("save-cue").innerHTML = enrollmentSaving
    ? "Learning…"
    : `Add to library${icon("arrow")}`;
}
async function openEnrollment() {
  if (recording || listenPending) return;
  if (!status || status.model_status !== "ready") {
    toast("Wait for YAMNet to finish loading, then try again.");
    return;
  }
  referenceAudio?.pause();
  resumeListening = !!socket;
  if (socket) await stopListening();
  examples = [];
  teacherJob = null;
  teacherPending = false;
  exampleUploading = 0;
  enrollmentSaving = false;
  enrollmentGeneration++;
  $("cue-name").value = "";
  $("teacher-result").classList.add("hidden");
  $("ask-teacher").innerHTML = `Ask Gemini${icon("arrow")}`;
  errorIn("enroll-error", "");
  $("capture-label").textContent = "Let’s hear your sound.";
  $("record-button").innerHTML = `${icon("mic")}Record 4 seconds`;
  $("drop-area").classList.remove("recording");
  $("capture-description").textContent =
    "Record a clear example, or drop in an audio file.";
  renderExamples();
  $("enroll-dialog").showModal();
}
document
  .querySelectorAll(".teach-button")
  .forEach((el) => (el.onclick = openEnrollment));
async function trySample() {
  await openEnrollment();
  if (!$("enroll-dialog").open) return;
  const generation = enrollmentGeneration;
  try {
    $("cue-name").value = "Two-tone lab chime";
    toast("Loading a synthetic lab sound. This uses the real encoder.");
    const response = await fetch("/static/samples/two-tone.wav");
    if (!response.ok) throw new Error("Sample file unavailable.");
    if (!(await uploadExample(await response.blob(), generation))) return;
    $("capture-description").textContent =
      "Synthetic sample loaded. Play it, then listen for the same chime.";
  } catch (error) {
    if (generation === enrollmentGeneration)
      errorIn("enroll-error", error.message);
  }
}
$("record-button").onclick = async () => {
  if (recordFinish) {
    recordFinish();
    return;
  }
  if (recording) return;
  const generation = enrollmentGeneration;
  errorIn("enroll-error", "");
  $("record-button").innerHTML = `${icon("mic")}Stop recording`;
  $("capture-label").textContent = "Waiting for microphone access…";
  $("capture-description").textContent =
    "Allow microphone access in the browser to begin.";
  $("drop-area").classList.add("recording");
  $("upload-button").disabled = true;
  $("save-cue").disabled = true;
  $("ask-teacher").disabled = true;
  try {
    const blob = await recordClip(
      4,
      (left) => {
        $("capture-label").textContent = "Listening for your example…";
        $("capture-description").textContent =
          `Make the sound now · ${left.toFixed(1)} seconds left`;
      },
      () => generation === enrollmentGeneration && $("enroll-dialog").open,
    );
    if (generation === enrollmentGeneration && $("enroll-dialog").open) {
      $("capture-label").textContent = "Processing your example…";
      await uploadExample(blob, generation);
    }
  } catch (error) {
    if (generation === enrollmentGeneration)
      errorIn("enroll-error", error.message);
  } finally {
    if (generation === enrollmentGeneration) {
      $("record-button").innerHTML = `${icon("mic")}Record 4 seconds`;
      $("drop-area").classList.remove("recording");
      $("capture-label").textContent = "Ready for another example.";
      $("capture-description").textContent =
        "Try a different distance or room position.";
      renderExamples();
    }
  }
};
$("upload-button").onclick = () => $("audio-file").click();
$("audio-file").onchange = async (event) => {
  const generation = enrollmentGeneration;
  errorIn("enroll-error", "");
  $("upload-button").disabled = true;
  try {
    for (const file of event.target.files)
      await uploadExample(file, generation);
  } catch (error) {
    if (generation === enrollmentGeneration)
      errorIn("enroll-error", error.message);
  } finally {
    if (generation === enrollmentGeneration) {
      event.target.value = "";
      renderExamples();
    }
  }
};
const drop = $("drop-area");
drop.ondragover = (event) => {
  event.preventDefault();
  drop.classList.add("dragover");
};
drop.ondragleave = () => drop.classList.remove("dragover");
drop.ondrop = async (event) => {
  event.preventDefault();
  drop.classList.remove("dragover");
  if (recording || teacherPending || enrollmentSaving) return;
  const generation = enrollmentGeneration;
  try {
    for (const file of event.dataTransfer.files)
      await uploadExample(file, generation);
  } catch (error) {
    if (generation === enrollmentGeneration)
      errorIn("enroll-error", error.message);
  }
};
$("ask-teacher").onclick = async () => {
  const generation = enrollmentGeneration;
  teacherPending = true;
  renderExamples();
  errorIn("enroll-error", "");
  $("ask-teacher").textContent = "Gemini is listening…";
  try {
    const job = await api("/api/teacher", {
      method: "POST",
      body: {
        examples: examples.map((e) => e.token),
        name: $("cue-name").value,
      },
    });
    if (generation !== enrollmentGeneration) return;
    teacherJob = job.id;
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (generation !== enrollmentGeneration) return;
      const state = await api(`/api/teacher/${job.id}`);
      if (generation !== enrollmentGeneration) return;
      if (state.status === "error") throw new Error(state.error);
      if (state.status === "done") {
        const result = state.result;
        if (!$("cue-name").value.trim()) $("cue-name").value = result.label;
        $("teacher-result").innerHTML =
          `<strong>${esc(result.label)}</strong><p>${esc(result.description)}</p><p>Try against: ${esc(result.confusable_sounds.join(", "))}.</p><p>${esc(result.recording_advice)}</p>${!result.consistent_examples ? "<p>These examples may not contain a consistent target. Review them before enrolling.</p>" : ""}`;
        $("teacher-result").classList.remove("hidden");
        $("ask-teacher").textContent = "Assessment complete";
        return;
      }
    }
    throw new Error(
      "Assessment timed out. Check your connection and try again.",
    );
  } catch (error) {
    if (generation === enrollmentGeneration) {
      errorIn("enroll-error", error.message);
      $("ask-teacher").textContent = "Try Gemini again";
    }
  } finally {
    if (generation === enrollmentGeneration) {
      teacherPending = false;
      renderExamples();
    }
  }
};
$("enroll-form").onsubmit = async (event) => {
  event.preventDefault();
  if (exampleUploading || enrollmentSaving || recording || teacherPending)
    return;
  const generation = enrollmentGeneration;
  enrollmentSaving = true;
  renderExamples();
  errorIn("enroll-error", "");
  $("save-cue").disabled = true;
  $("save-cue").textContent = "Learning…";
  try {
    const cue = await api("/api/cues", {
      method: "POST",
      body: {
        name: $("cue-name").value,
        examples: examples.map((e) => e.token),
        teacher_job: teacherJob,
      },
    });
    if (generation === enrollmentGeneration) {
      examples = [];
      $("enroll-dialog").close();
    }
    await refresh();
    toast(`Learned ${cue.name}. Your listener is ready.`);
  } catch (error) {
    if (generation === enrollmentGeneration)
      errorIn("enroll-error", error.message);
  } finally {
    if (generation === enrollmentGeneration) {
      enrollmentSaving = false;
      $("save-cue").innerHTML = `Add to library${icon("arrow")}`;
      renderExamples();
    }
  }
};
$("enroll-dialog").addEventListener("close", async () => {
  enrollmentGeneration++;
  exampleUploading = 0;
  teacherPending = false;
  enrollmentSaving = false;
  recordFinish?.();
  $("example-list")
    .querySelectorAll("audio")
    .forEach((audio) => audio.pause());
  for (const example of examples)
    api(`/api/examples/${example.token}`, { method: "DELETE" }).catch(() => {});
  examples = [];
  if (resumeListening) {
    resumeListening = false;
    while (recording) await new Promise((resolve) => setTimeout(resolve, 100));
    await startListening();
  }
});

function openCue(id) {
  const cue = status.cues.find((c) => c.id === id);
  if (!cue) return;
  editingCue = id;
  $("edit-name").value = cue.name;
  $("edit-threshold").value = cue.threshold;
  $("edit-threshold-output").value = cue.threshold.toFixed(2);
  $("edit-hits").value = cue.hits;
  $("edit-cooldown").value = cue.cooldown;
  errorIn("cue-error", "");
  $("delete-cue").textContent = "Delete sound";
  $("saved-teacher").classList.toggle("hidden", !cue.teacher);
  if (cue.teacher)
    $("saved-teacher").innerHTML =
      `Gemini assessment<small>${esc(cue.teacher.description)}</small><small>Confusable sounds: ${esc(cue.teacher.confusable_sounds.join(", "))}</small>`;
  $("cue-dialog").showModal();
}
$("edit-threshold").oninput = () =>
  ($("edit-threshold-output").value = Number($("edit-threshold").value).toFixed(
    2,
  ));
$("cue-settings-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api(`/api/cues/${editingCue}`, {
      method: "PATCH",
      body: {
        name: $("edit-name").value,
        threshold: Number($("edit-threshold").value),
        hits: Number($("edit-hits").value),
        cooldown: Number($("edit-cooldown").value),
      },
    });
    $("cue-dialog").close();
    await refresh();
    toast("Cue settings saved.");
  } catch (error) {
    errorIn("cue-error", error.message);
  }
};
$("delete-cue").onclick = async () => {
  if ($("delete-cue").textContent !== "Confirm delete") {
    $("delete-cue").textContent = "Confirm delete";
    return;
  }
  try {
    await api(`/api/cues/${editingCue}`, { method: "DELETE" });
    $("cue-dialog").close();
    await refresh();
    toast("Sound removed from the library.");
  } catch (error) {
    errorIn("cue-error", error.message);
  }
};

async function openConnections() {
  await refresh();
  if (!status) return;
  $("ros-enabled").checked = status.ros.enabled;
  $("ros-url").value = status.ros.url;
  $("ros-topic").value = status.ros.topic;
  errorIn("ros-error", "");
  $("connections-dialog").showModal();
}
$("connections-nav").onclick = openConnections;
$("ros-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/ros", {
      method: "PUT",
      body: {
        enabled: $("ros-enabled").checked,
        url: $("ros-url").value,
        topic: $("ros-topic").value,
      },
    });
    errorIn("ros-error", "");
    await refresh();
    toast("Connection settings saved.");
  } catch (error) {
    errorIn("ros-error", error.message);
  }
};
$("test-ros").onclick = async () => {
  try {
    const result = await api("/api/ros/test", { method: "POST" });
    toast(
      result.delivery === "queued"
        ? "Test event queued. Check the bridge terminal or ROS subscriber."
        : `Test was not sent: bridge ${result.delivery}.`,
    );
    await refresh();
  } catch (error) {
    errorIn("ros-error", error.message);
  }
};
$("test-recording-button").onclick = () => $("test-file").click();
$("test-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $("test-recording-button").disabled = true;
  $("test-result").className = "notice";
  $("test-result").textContent =
    "Running this recording through the real detector…";
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/test", { method: "POST", body: form });
    const maxScores = new Map();
    for (const frame of result.frames)
      for (const score of frame.scores)
        maxScores.set(
          score.id,
          Math.max(maxScores.get(score.id) || 0, score.score),
        );
    updateScores(maxScores);
    $("test-result").textContent =
      `${result.duration.toFixed(1)}s tested · ${result.events.length} detection${result.events.length === 1 ? "" : "s"}${result.events.length ? `: ${result.events.map((e) => e.name).join(", ")}` : ""}. Peak similarities shown on cue cards. No ROS events were published.`;
  } catch (error) {
    $("test-result").className = "notice error";
    $("test-result").textContent = error.message;
  } finally {
    $("test-recording-button").disabled = false;
    event.target.value = "";
  }
};
$("calibrate-button").onclick = async () => {
  if (recording || listenPending) return;
  calibrationGeneration++;
  $("record-background").disabled = false;
  resumeListening = !!socket;
  if (socket) await stopListening();
  $("calibration-status").textContent = status?.background_calibrated
    ? "A room reference is saved. Record again to replace it."
    : "Keep the microphone where you’ll usually listen.";
  $("calibrate-dialog").showModal();
};
$("record-background").onclick = async () => {
  if (recording) return;
  const generation = calibrationGeneration;
  $("record-background").disabled = true;
  $("calibration-status").textContent =
    "Waiting for microphone access. Allow it in the browser to begin.";
  try {
    const blob = await recordClip(
      5,
      (left) =>
        ($("calibration-status").textContent =
          `Recording the room · ${left.toFixed(1)} seconds remaining`),
      () => generation === calibrationGeneration && $("calibrate-dialog").open,
    );
    if (generation !== calibrationGeneration || !$("calibrate-dialog").open)
      return;
    const form = new FormData();
    form.append("file", blob, "room.wav");
    await api("/api/background", { method: "POST", body: form });
    if (generation !== calibrationGeneration) return;
    $("calibration-status").textContent =
      "Room reference saved. Target sounds must now beat this background match.";
    toast("Room calibration saved.");
    await refresh();
  } catch (error) {
    if (generation === calibrationGeneration)
      $("calibration-status").textContent = error.message;
  } finally {
    if (generation === calibrationGeneration)
      $("record-background").disabled = false;
  }
};
$("reset-background").onclick = async () => {
  try {
    await api("/api/background", { method: "DELETE" });
    $("calibration-status").textContent = "Room reference cleared.";
    await refresh();
  } catch (error) {
    toast(error.message);
  }
};
$("calibrate-dialog").addEventListener("close", async () => {
  calibrationGeneration++;
  recordFinish?.();
  if (resumeListening) {
    resumeListening = false;
    while (recording) await new Promise((resolve) => setTimeout(resolve, 100));
    startListening();
  }
});
$("export-events").onclick = () => {
  const content = (status?.events || [])
    .slice()
    .reverse()
    .map((e) => JSON.stringify(e))
    .join("\n");
  const url = URL.createObjectURL(
    new Blob([content ? content + "\n" : ""], { type: "application/x-ndjson" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "physical-shazam-events.jsonl";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(
    "Exported the recent event history. Full history remains in data/events.jsonl.",
  );
};
document
  .querySelectorAll("[data-close]")
  .forEach((el) => (el.onclick = () => $(el.dataset.close).close()));
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });

const diagramSvg = $("system-diagram");
const diagram = new SystemDiagram(diagramSvg);
const live = { frames: 0, inferenceMs: null, level: null, lastEvent: null };
diagramSvg.addEventListener("click", (event) => {
  const id = event.target.closest("[data-node]")?.dataset.node;
  if (id === "gemini" || id === "ros") openConnections();
  else if (id === "library") switchPage("library");
  else if (id === "journal") switchPage("journal");
  else if (id === "mic" && !socket && !listenPending) startListening();
});
function bestMatch() {
  let best = null;
  for (const cue of status?.cues || []) {
    const score = latestScores.get(cue.id);
    if (cue.enabled && score != null && (!best || score > best.score))
      best = { name: cue.name, score, threshold: cue.threshold };
  }
  return best;
}
function updateDiagram() {
  if (!status) return;
  const listening = Boolean(socket) && !listenPending;
  const model = status.model_status;
  const cues = status.cues || [];
  const enabled = cues.filter((c) => c.enabled).length;
  const best = listening ? bestMatch() : null;
  const ros = status.ros;
  const last = live.lastEvent || status.events[0];
  diagram.set(
    "mic",
    listening ? "active" : model === "ready" ? "ready" : "idle",
    listening
      ? `${$("input-level").textContent}`
      : model === "ready"
        ? "Click to start"
        : "Waiting for encoder",
  );
  diagram.set(
    "window",
    listening ? "active" : "idle",
    `${status.sample_rate / 1000} kHz · ${Math.round(status.window_ms)} ms`,
  );
  diagram.set(
    "encoder",
    model === "error"
      ? "error"
      : model !== "ready"
        ? "warn"
        : listening
          ? "active"
          : "ready",
    model === "error"
      ? "Unavailable · retry"
      : model !== "ready"
        ? "Loading YAMNet…"
        : listening && live.inferenceMs != null
          ? `YAMNet · ${Math.round(live.inferenceMs)} ms`
          : "YAMNet · ready",
  );
  diagram.set(
    "library",
    cues.length ? "ready" : "warn",
    cues.length
      ? `${cues.length} sound${cues.length === 1 ? "" : "s"} · ${enabled} on`
      : "Teach a sound",
  );
  diagram.set(
    "gemini",
    teacherPending ? "active" : status.teacher.configured ? "ready" : "off",
    teacherPending
      ? "Reviewing examples…"
      : status.teacher.configured
        ? "On demand"
        : "No API key",
  );
  diagram.set(
    "match",
    !listening ? "idle" : !enabled ? "warn" : "active",
    !listening
      ? `${enabled} cue${enabled === 1 ? "" : "s"} armed`
      : !enabled
        ? "No cues enabled"
        : best
          ? `${best.score.toFixed(2)} · ${best.name}`
          : "Scoring…",
  );
  diagram.set(
    "event",
    last ? "ready" : "idle",
    last ? last.name : "Nothing yet",
  );
  diagram.set(
    "journal",
    status.events.length ? "ready" : "idle",
    `${status.events.length} saved locally`,
  );
  diagram.set(
    "ros",
    { connected: "ready", connecting: "warn", offline: "error", disabled: "off" }[
      ros.status
    ] || "off",
    {
      connected: `${ros.sent} sent`,
      connecting: "Connecting…",
      offline: "Bridge offline",
      disabled: "Not connected",
    }[ros.status] || ros.status,
  );
  diagram.flow("mic", "window", listening);
  diagram.flow("window", "encoder", listening);
  diagram.flow("encoder", "match", listening);
  diagram.flow("library", "match", listening && enabled > 0);
  diagram.flow("gemini", "library", teacherPending);
  diagram.flow("event", "ros", ros.status === "connected");
  $("stat-latency").textContent =
    live.inferenceMs != null
      ? `${Math.round(live.inferenceMs)} ms`
      : status.inference_ms != null
        ? `${Math.round(status.inference_ms)} ms`
        : "—";
  $("stat-frames").textContent = listening
    ? live.frames.toLocaleString()
    : status.frames.toLocaleString();
  $("stat-match").textContent = best
    ? `${best.score.toFixed(3)} / ${best.threshold.toFixed(2)}`
    : "—";
  $("stat-ros").textContent =
    ros.status === "connected"
      ? `${ros.sent} sent · ${ros.dropped} dropped`
      : { connecting: "Connecting…", offline: "Offline" }[ros.status] || "Off";
  const steps = { teach: cues.length > 0, listen: listening, detect: status.events.length > 0 };
  for (const [step, done] of Object.entries(steps))
    $(`step-${step}`).classList.toggle("done", done);
}
function animateDiagram(now) {
  diagram.frame(now);
  requestAnimationFrame(animateDiagram);
}
requestAnimationFrame(animateDiagram);

const canvas = $("waveform"),
  ctx = canvas.getContext("2d");
function draw() {
  const rect = canvas.getBoundingClientRect(),
    dpr = devicePixelRatio || 1;
  if (
    canvas.width !== Math.round(rect.width * dpr) ||
    canvas.height !== Math.round(rect.height * dpr)
  ) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const mid = rect.height / 2;
  ctx.strokeStyle = socket ? "#b8de90" : "#4b623b";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const steps = Math.max(
    1,
    Math.floor(waveformSamples.length / Math.max(1, rect.width)),
  );
  for (let x = 0; x < rect.width; x++) {
    let peak = 0;
    const start = x * steps;
    for (
      let j = start;
      j < Math.min(start + steps, waveformSamples.length);
      j++
    )
      peak = Math.max(peak, Math.abs(waveformSamples[j]));
    const y = Math.min(mid - 20, peak * mid * 2.6);
    if (socket) {
      ctx.moveTo(x, mid - y);
      ctx.lineTo(x, mid + y || mid + 0.2);
    } else {
      if (x === 0) ctx.moveTo(x, mid);
      else ctx.lineTo(x, mid);
    }
  }
  ctx.stroke();
  requestAnimationFrame(draw);
}
window.addEventListener("pagehide", () => {
  socket?.close();
  microphone?.stream.getTracks().forEach((t) => t.stop());
});
renderEvents();
refresh();
setInterval(refresh, 2000);
requestAnimationFrame(draw);
