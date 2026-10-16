export { DIVISIONS, SYNC_OPTIONS, divisionBeats, syncRange } from '../shared/sync.js';

export const SMOOTHING = 0.015;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const CHORDS = {
  Unison: [0],
  Octave: [0, 12],
  Fifth: [0, 7],
  Minor: [0, 3, 7],
  Major: [0, 4, 7],
  Sus4: [0, 5, 7],
  Minor7: [0, 3, 7, 10]
};

export function beatsToSeconds(beats, bpm) {
  return (beats * 60) / bpm;
}

export function midiToHz(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function holdAt(param, time) {
  const current = param.value;
  param.cancelScheduledValues(time);
  param.setValueAtTime(current, time);
  return current;
}

export function fadeTo(param, value, now, at, length) {
  const current = holdAt(param, now);
  if (at > now) param.setValueAtTime(current, at);
  param.linearRampToValueAtTime(value, at + length);
}

export function ramp(ctx, audioParam, value, immediate) {
  if (immediate) audioParam.value = value;
  else audioParam.setTargetAtTime(value, ctx.currentTime, SMOOTHING);
}

export function stereoInput(ctx) {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  return input;
}

const noiseCache = new WeakMap();

export function noiseBuffer(ctx, seconds = 3) {
  if (noiseCache.has(ctx)) return noiseCache.get(ctx);
  const buffer = ctx.createBuffer(2, Math.round(seconds * ctx.sampleRate), ctx.sampleRate);
  let seed = 0x2f6b;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
  }
  noiseCache.set(ctx, buffer);
  return buffer;
}

export function loopSource(ctx, buffer, playbackRate = 1) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.playbackRate.value = playbackRate;
  source.start();
  return source;
}

export function lfo(ctx, type, frequency) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = frequency;
  osc.start();
  return osc;
}

export function curve(size, fn) {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = fn((i / (size - 1)) * 2 - 1);
  return out;
}

export function tanhCurve(amount, asymmetry = 0) {
  const k = 1 + amount * 20;
  return curve(2048, (x) => Math.tanh(k * (x + asymmetry * x * x)) / k);
}

export function workletNode(ctx, processor, params, bpm, origin = 0) {
  const node = new AudioWorkletNode(ctx, processor, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: { bpm },
    processorOptions: { params, origin }
  });
  return {
    node,
    set(id, value) {
      node.port.postMessage({ type: 'param', id, value });
    },
    tempo(value) {
      node.parameters.get('bpm').setValueAtTime(value, ctx.currentTime);
    },
    grid(value) {
      node.port.postMessage({ type: 'grid', origin: value });
    },
    active(on, when = 0) {
      const param = node.parameters.get('active');
      holdAt(param, ctx.currentTime);
      param.setValueAtTime(on ? 1 : 0, Math.max(ctx.currentTime, when));
    }
  };
}

export function workletEffect(processor, fixed = {}) {
  return (ctx, initial, { bpm = 90, origin = 0 } = {}) => {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const worklet = workletNode(ctx, processor, { ...fixed, ...initial }, bpm, origin);
    input.connect(worklet.node).connect(output);
    return {
      input,
      output,
      setParam: (id, value) => worklet.set(id, value),
      setTempo: (value) => worklet.tempo(value),
      setGrid: (value) => worklet.grid(value),
      setActive: (on, when) => worklet.active(on, when),
      dispose() {
        disconnectAll(input, worklet.node, output);
      }
    };
  };
}

export function disconnectAll(...nodes) {
  for (const node of nodes) {
    if (typeof node.dispose === 'function') {
      node.dispose();
      continue;
    }
    if (typeof node.stop === 'function') {
      try {
        node.stop();
      } catch {}
    }
    node.disconnect();
  }
}

export function effectShell({ input, output, values, apply, nodes = [], onTempo, onActive }) {
  for (const [id, value] of Object.entries(values)) apply[id]?.(value, true);
  return {
    input,
    output,
    setParam(id, value) {
      values[id] = value;
      apply[id]?.(value, false);
    },
    setTempo: onTempo,
    setActive: onActive,
    dispose() {
      disconnectAll(input, output, ...nodes);
    }
  };
}
