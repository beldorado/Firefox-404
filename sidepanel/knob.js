import { h } from './dom.js';
import { clamp, formatValue, fromNormalized, toNormalized } from '../shared/params.js';

const SWEEP = 135;
const RADIUS = 19;
const DRAG_PIXELS = 160;
const FINE = 0.2;
const WHEEL_STEP = 0.02;
const SVG = 'http://www.w3.org/2000/svg';

function point(angle) {
  const rad = (angle * Math.PI) / 180;
  return `${(25 + RADIUS * Math.sin(rad)).toFixed(2)} ${(25 - RADIUS * Math.cos(rad)).toFixed(2)}`;
}

function arc(from, to) {
  const large = to - from > 180 ? 1 : 0;
  return `M ${point(from)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${point(to)}`;
}

export function createKnob({ param, onChange, onArm }) {
  const el = h('div', { className: 'knob', title: 'Drag up/down (Shift = fine) · double-click to reset' });
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 50 50');
  const track = document.createElementNS(SVG, 'path');
  track.setAttribute('class', 'knob-track');
  track.setAttribute('d', arc(-SWEEP, SWEEP));
  const valuePath = document.createElementNS(SVG, 'path');
  valuePath.setAttribute('class', 'knob-value');
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('class', 'knob-dot');
  dot.setAttribute('r', '3');
  svg.append(track, valuePath, dot);
  el.append(svg);
  const readout = h('output', { className: 'knob-readout' });
  el.append(readout, h('label', { textContent: param.name }));

  let normalized = 0;
  let drag = null;

  const draw = (value) => {
    normalized = toNormalized(param, value);
    const angle = -SWEEP + normalized * SWEEP * 2;
    valuePath.setAttribute('d', normalized > 0.001 ? arc(-SWEEP, angle) : '');
    const [x, y] = point(angle).split(' ');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    readout.textContent = formatValue(param, value);
  };

  const commit = (n) => {
    const value = fromNormalized(param, clamp(n, 0, 1));
    draw(value);
    onChange(value);
  };

  el.addEventListener('pointerdown', (e) => {
    onArm?.(el);
    el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, n: normalized };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scale = e.shiftKey ? FINE : 1;
    commit(drag.n + ((drag.y - e.clientY) / DRAG_PIXELS) * scale);
  });
  const end = () => {
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => commit(toNormalized(param, param.default)));
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      commit(normalized + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP) * (e.shiftKey ? FINE : 1));
    },
    { passive: false }
  );

  return {
    el,
    setValue(value) {
      if (!drag) draw(value);
    }
  };
}
