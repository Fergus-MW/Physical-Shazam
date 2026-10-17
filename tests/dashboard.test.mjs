import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../src/physical_shazam/static/app.js", import.meta.url),
  "utf8",
);
const html = readFileSync(
  new URL("../src/physical_shazam/static/index.html", import.meta.url),
  "utf8",
);
const diagramSource = readFileSync(
  new URL("../src/physical_shazam/static/diagram.js", import.meta.url),
  "utf8",
);
const elementIds = new Set(
  [...`${html}\n${source}`.matchAll(/\bid="([^"]+)"/g)].map(
    (match) => match[1],
  ),
);

test("dashboard controls reference elements present in the real page", () => {
  for (const [, id] of source.matchAll(/\$\(["']([^"']+)["']\)/g)) {
    assert.ok(elementIds.has(id), `Missing dashboard element: ${id}`);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function dashboard() {
  const elements = new Map(),
    calls = [];
  class Element {
    constructor() {
      this.open = false;
      this.value = "";
      this.dataset = {};
      this.listeners = new Map();
      this.style = {};
      this.style.setProperty = (name, value) => {
        this.style[name] = value;
      };
      this.children = [];
      this.attributes = {};
      this.textContent = "";
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, hidden) =>
          hidden ? classes.add(name) : classes.delete(name),
      };
    }
    querySelectorAll() {
      return [];
    }
    addEventListener(event, handler) {
      this.listeners.set(event, handler);
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      queueMicrotask(() => this.listeners.get("close")?.());
    }
    getContext() {
      return {};
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
    }
    replaceChildren() {
      this.children = [];
    }
    remove() {
      this.parentNode.children = this.parentNode.children.filter(
        (child) => child !== this,
      );
    }
    getTotalLength() {
      return 100;
    }
    getPointAtLength(length) {
      return { x: length, y: 0 };
    }
  }
  const get = (id) => {
    if (!elementIds.has(id)) return null;
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const status = {
    encoder: "ced-small-test",
    sample_rate: 16000,
    window_ms: 975,
    frames: 0,
    model_status: "ready",
    teacher: { configured: false, model: "test" },
    ros: { status: "disabled", sent: 0, dropped: 0 },
    cues: [],
    events: [],
    inference_ms: null,
  };
  let respond = async () => ({});
  const context = vm.createContext({
    document: {
      getElementById: get,
      querySelectorAll: () => [],
      createElementNS: () => new Element(),
    },
    window: { addEventListener() {} },
    setInterval() {},
    requestAnimationFrame() {},
    setTimeout,
    clearTimeout,
    performance,
    FormData,
    Blob,
    URL,
    fetch: async (path, options = {}) => {
      calls.push({ path, options });
      const result =
        path === "/api/status" ? status : await respond(path, options);
      return { ok: true, json: async () => result };
    },
  });
  // Evaluate both real modules in one isolated lexical scope; the harness supplies SVG geometry.
  vm.runInContext(diagramSource.replace(/^export /gm, ""), context);
  vm.runInContext(
    source.replace(
      /^import \{ SystemDiagram \} from "\/static\/diagram.js";\s*/,
      "",
    ),
    context,
  );
  await new Promise(setImmediate);
  return {
    get,
    calls,
    run: (code) => vm.runInContext(code, context),
    respond(fn) {
      respond = fn;
    },
    context,
  };
}

test("the system diagram reflects CED-small and clears completed audio packets", async () => {
  const app = await dashboard();
  assert.equal(
    app.run("diagram.nodes.encoder.value.textContent"),
    "CED-small · ready",
  );
  assert.equal(app.run("diagram.nodes.encoder.state"), "ready");
  app.run(
    "diagram.send(['mic','window','encoder'],0,{duration:100});diagram.frame(50)",
  );
  assert.equal(app.run("diagram.packets.length"), 1);
  app.run("diagram.frame(250)");
  assert.equal(app.run("diagram.packets.length"), 0);
  assert.equal(app.run("diagram.packetLayer.children.length"), 0);
  assert.ok(Number(app.run("diagram.nodes.encoder.g.style['--flash']")) > 0);
});

test("a completed upload cannot enter a different enrollment after cancellation", async () => {
  const app = await dashboard(),
    pending = deferred();
  app.respond((path) => (path === "/api/examples" ? pending.promise : {}));
  await app.run("openEnrollment()");
  const upload = app.run("uploadExample(new Blob(['audio']))");
  app.get("enroll-dialog").close();
  await new Promise(setImmediate);
  await app.run("openEnrollment()");
  pending.resolve({ token: "abandoned", duration: 2, level_db: -20 });
  await upload;
  assert.equal(app.get("example-count").textContent, "0 / 5");
  assert.ok(
    app.calls.some(
      (call) =>
        call.path === "/api/examples/abandoned" &&
        call.options.method === "DELETE",
    ),
  );
});

test("closing room calibration discards its recording instead of changing the room reference", async () => {
  const app = await dashboard(),
    pending = deferred();
  app.context.pendingRecording = pending.promise;
  app.run("recordClip = () => pendingRecording");
  await app.get("calibrate-button").onclick();
  const recording = app.get("record-background").onclick();
  app.get("calibrate-dialog").close();
  await new Promise(setImmediate);
  pending.resolve(new Blob(["audio"]));
  await recording;
  assert.equal(
    app.calls.filter((call) => call.path === "/api/background").length,
    0,
  );
});

test("a second upload cannot exceed the five-example limit while the first is pending", async () => {
  const app = await dashboard(),
    pending = deferred();
  app.respond((path) => (path === "/api/examples" ? pending.promise : {}));
  await app.run(
    "openEnrollment(); examples = Array.from({length:4}, (_,i)=>({token:String(i),duration:2,level_db:-20}));",
  );
  const first = app.run("uploadExample(new Blob(['audio']))");
  const second = app.run("uploadExample(new Blob(['audio']))");
  pending.resolve({ token: "fifth", duration: 2, level_db: -20 });
  const results = await Promise.allSettled([first, second]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(app.get("example-count").textContent, "5 / 5");
});

test("an old teacher request cannot unlock or overwrite a newer enrollment", async () => {
  const app = await dashboard(),
    first = deferred(),
    second = deferred();
  let requests = 0;
  app.respond((path) =>
    path === "/api/teacher"
      ? ++requests === 1
        ? first.promise
        : second.promise
      : { status: "error", error: "Test provider unavailable" },
  );
  await app.run(
    "openEnrollment(); examples = [{token:'first',duration:2,level_db:-20}]",
  );
  const oldJob = app.get("ask-teacher").onclick();
  app.get("enroll-dialog").close();
  await new Promise(setImmediate);
  await app.run(
    "openEnrollment(); examples = [{token:'second',duration:2,level_db:-20}]",
  );
  const newJob = app.get("ask-teacher").onclick();
  first.resolve({ id: "old" });
  await oldJob;
  assert.equal(app.run("teacherPending"), true);
  assert.equal(app.run("teacherJob"), null);
  second.resolve({ id: "new" });
  await newJob;
});

test("completion of an old save does not close a newly opened enrollment", async () => {
  const app = await dashboard(),
    pending = deferred();
  app.respond((path) => (path === "/api/cues" ? pending.promise : {}));
  await app.run(
    "openEnrollment(); examples = [{token:'first',duration:2,level_db:-20}]",
  );
  app.get("cue-name").value = "Old sound";
  const save = app.get("enroll-form").onsubmit({ preventDefault() {} });
  app.get("enroll-dialog").close();
  await new Promise(setImmediate);
  await app.run("openEnrollment()");
  pending.resolve({ id: "saved", name: "Old sound" });
  await save;
  assert.equal(app.get("enroll-dialog").open, true);
  assert.equal(app.get("example-count").textContent, "0 / 5");
  assert.match(app.get("save-cue").innerHTML, /Add to library/);
});

test("a microphone granted after cancellation is closed without uploading audio", async () => {
  const app = await dashboard(),
    pending = deferred();
  app.context.permission = pending.promise;
  app.run(
    "createMicrophone = async () => { const mic = await permission; microphone = mic; return mic; }",
  );
  await app.run("openEnrollment()");
  const capture = app.get("record-button").onclick();
  app.get("enroll-dialog").close();
  await new Promise(setImmediate);
  let closed = 0;
  pending.resolve({
    rate: 48000,
    async close() {
      closed++;
      app.run("microphone = null");
    },
  });
  await capture;
  assert.equal(closed, 1);
  assert.equal(app.run("recording"), false);
  assert.equal(
    app.calls.filter((call) => call.path === "/api/examples").length,
    0,
  );
});
