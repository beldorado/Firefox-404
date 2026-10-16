class TapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunk = options.processorOptions?.chunk ?? 1024;
    this.reset();
  }

  reset() {
    this.left = new Float32Array(this.chunk);
    this.right = new Float32Array(this.chunk);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const left = input?.[0];
    if (!left) return true;
    const right = input[1] ?? left;
    for (let i = 0; i < left.length; i++) {
      this.left[this.filled] = left[i];
      this.right[this.filled] = right[i];
      if (++this.filled === this.chunk) {
        this.port.postMessage({ l: this.left, r: this.right }, [this.left.buffer, this.right.buffer]);
        this.reset();
      }
    }
    return true;
  }
}

registerProcessor('firefox404-tap', TapProcessor);
