const SIZE = 1 << 17;
const MAX_NUDGE = 0.01;
const NUDGE_GAIN = 0.01;
const STATS_EVERY = 0.25;

class StreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sourceRate = sampleRate, targetMs = 60 } = options.processorOptions ?? {};
    this.ratio = sourceRate / sampleRate;
    this.target = Math.round((targetMs / 1000) * sourceRate);
    this.left = new Float32Array(SIZE);
    this.right = new Float32Array(SIZE);
    this.written = 0;
    this.read = 0;
    this.primed = false;
    this.underruns = 0;
    this.nextStats = 0;
    this.sourceRate = sourceRate;
    this.port.onmessage = ({ data }) => this.push(data.l, data.r);
  }

  push(left, right) {
    for (let i = 0; i < left.length; i++) {
      const at = (this.written + i) % SIZE;
      this.left[at] = left[i];
      this.right[at] = right[i];
    }
    this.written += left.length;
    if (this.written - this.read > SIZE / 2) this.read = this.written - this.target;
  }

  sample(channel, position) {
    const i = Math.floor(position);
    const f = position - i;
    const a = channel[i % SIZE];
    return a + (channel[(i + 1) % SIZE] - a) * f;
  }

  process(_, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outL;
    const fill = this.written - this.read;
    if (!this.primed && fill >= this.target) this.primed = true;
    if (this.primed) {
      const step = this.ratio * (1 + Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, ((fill - this.target) / this.target) * NUDGE_GAIN)));
      for (let i = 0; i < outL.length; i++) {
        if (this.written - this.read < 2) {
          this.primed = false;
          this.underruns++;
          outL.fill(0, i);
          outR.fill(0, i);
          break;
        }
        outL[i] = this.sample(this.left, this.read);
        outR[i] = this.sample(this.right, this.read);
        this.read += step;
      }
    }
    if (currentTime >= this.nextStats) {
      this.nextStats = currentTime + STATS_EVERY;
      this.port.postMessage({ bufferedMs: ((this.written - this.read) / this.sourceRate) * 1000, underruns: this.underruns, primed: this.primed });
    }
    return true;
  }
}

registerProcessor('firefox404-stream', StreamProcessor);
