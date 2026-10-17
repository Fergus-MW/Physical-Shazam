class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.48);
    this.buffer = new Float32Array(this.size);
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "flush") {
        if (this.offset) {
          const tail = this.buffer.slice(0, this.offset);
          this.port.postMessage(tail, [tail.buffer]);
          this.offset = 0;
        }
        this.port.postMessage("flushed");
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input?.length) return true;
    for (let i = 0; i < input[0].length; i++) {
      let sample = 0;
      for (const channel of input) sample += channel[i] / input.length;
      this.buffer[this.offset++] = sample;
      if (this.offset === this.size) {
        const chunk = this.buffer;
        this.port.postMessage(chunk, [chunk.buffer]);
        this.buffer = new Float32Array(this.size);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", CaptureProcessor);
