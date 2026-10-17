import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("worklet preserves every sample across 480 ms boundaries and final flush", () => {
  const emitted = [];
  let Processor;
  class BaseProcessor {
    constructor() {
      this.port = {
        postMessage(message, transfer = []) {
          emitted.push(structuredClone(message, { transfer }));
        },
      };
    }
  }
  const context = vm.createContext({
    AudioWorkletProcessor: BaseProcessor,
    sampleRate: 48000,
    registerProcessor(name, value) {
      assert.equal(name, "pcm-capture");
      Processor = value;
    },
  });
  vm.runInContext(
    readFileSync(
      new URL(
        "../src/physical_shazam/static/capture-processor.js",
        import.meta.url,
      ),
      "utf8",
    ),
    context,
  );
  const processor = new Processor();
  const total = 200 * 128;
  for (let offset = 0; offset < total; offset += 128) {
    const left = Float32Array.from(
      { length: 128 },
      (_, i) => (offset + i) / total,
    );
    const right = new Float32Array(128).fill(0.5);
    assert.equal(processor.process([[left, right]]), true);
  }
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].length, 23040);
  processor.port.onmessage({ data: "flush" });
  assert.equal(emitted.at(-1), "flushed");
  const samples = [...emitted[0], ...emitted[1]];
  assert.equal(samples.length, total);
  samples.forEach((value, i) =>
    assert.ok(Math.abs(value - (i / total / 2 + 0.25)) < 1e-7),
  );
  processor.port.onmessage({ data: "flush" });
  assert.equal(emitted.length, 4); // A second flush adds only its completion message.
});
