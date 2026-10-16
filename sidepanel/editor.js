import { cssVar, h, hiDpiCanvas } from './dom.js';
import { MSG } from '../shared/messages.js';
import { padLabel } from '../shared/state.js';
import { cleanChops, detectTransients, equalChops, extractSlice, mono, slicesFrom, snapTime, truncateClip, MIN_SLICE_SECONDS } from '../shared/chop.js';
import { getClip, putClip } from '../shared/pad-store.js';
import { clamp } from '../shared/params.js';
import { confirmButton } from './widgets.js';

const HIT_PX = 7;
const SAVE_DELAY_MS = 300;
const LOAD_TRIES = 10;
const SPLITS = [2, 4, 8, 16];
const SENSITIVITY = { Fewer: 0.25, Normal: 0.5, More: 0.8 };
const ZOOM_RATE = 0.0015;
const AMP_RATE = 0.002;
const MAX_GAIN = 32;
const MIN_VIEW_FRAMES = 128;
const PAD_HEAD_STALE_S = 0.3;

const fmt = (t) => `${t.toFixed(3)} s`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePadsAfter(pads, index) {
  const out = [];
  for (let k = 1; k < pads.length; k++) {
    const i = (index + k) % pads.length;
    if (!pads[i].clip) out.push(i);
  }
  return out;
}

export function createEditor({ send, getState, showStatus, flash, onSlicesSent = () => {}, onClose = () => {} }) {
  let index = null;
  let record = null;
  let data = null;
  let duration = 0;
  let start = 0;
  let end = 0;
  let chops = [];
  let drag = null;
  let columns = null;
  let playhead = null;
  let padHead = null;
  let padPlaying = false;
  let raf = 0;
  let saveTimer = null;
  let sensitivity = 'Normal';
  let clipKey = '';
  let viewStart = 0;
  let viewEnd = 0;
  let gain = 1;
  let pan = null;
  let grab = null;

  const canvas = h('canvas', {
    className: 'wave-graph',
    tabIndex: 0,
    'aria-label': 'Waveform. Click a slice to hear it, double-click to add a chop, drag the S and E handles to trim, double-click a chop line to remove it. Shift+scroll zooms in time, Alt+scroll zooms the amplitude, holding the scroll wheel down and dragging moves along, and Shift or Alt+double-click resets that zoom.',
    title: 'Shift+scroll to zoom in time, Alt+scroll to zoom the amplitude. Hold the scroll wheel down and drag to move along. Shift+double-click or Alt+double-click resets that zoom.'
  });
  const thumb = h('div', { className: 'wave-window' });
  const overview = h('div', { className: 'wave-overview', hidden: true, title: 'Drag to move through the sample', 'aria-hidden': 'true' }, thumb);
  const title = h('p', { className: 'editor-title' });
  const readout = h('div', { className: 'editor-readout', 'aria-live': 'polite' });
  const snap = h('input', { type: 'checkbox', checked: true });
  const snapLabel = h('label', { className: 'check', title: 'Move chops and trim points to the nearest point where the waveform crosses zero, so slices start and end without a click. Turn it off to place them exactly.' }, snap, ' Snap to zero crossings');
  const play = h('button', { type: 'button', className: 'key key-small', textContent: 'Play', onclick: () => togglePlay() });
  const chopKey = h('button', { type: 'button', className: 'key key-small', textContent: 'Chop (G)', title: 'While it plays, drop a chop where you hear it', onclick: () => chopAtPlayhead() });
  const split = h(
    'select',
    {
      'aria-label': 'Split evenly',
      onchange: (e) => {
        const n = Number(e.target.value);
        e.target.value = '';
        e.target.blur();
        if (n) setChops(equalChops(start, end, n), `Split into ${n}`);
      }
    },
    h('option', { value: '', textContent: 'Split evenly…' }),
    ...SPLITS.map((n) => h('option', { value: String(n), textContent: `${n} slices` }))
  );
  const hits = h('button', { type: 'button', className: 'key key-small', textContent: 'Find hits', title: 'Put a chop at every drum hit or note start', onclick: () => findHits() });
  const sens = h(
    'select',
    {
      'aria-label': 'Hit sensitivity',
      onchange: (e) => {
        sensitivity = e.target.value;
        e.target.blur();
      }
    },
    ...Object.keys(SENSITIVITY).map((k) => h('option', { value: k, textContent: `${k} hits` }))
  );
  sens.value = sensitivity;
  const clearChops = h('button', { type: 'button', className: 'key key-small', textContent: 'Clear chops', onclick: () => setChops([], 'Chops cleared') });
  const resetTrim = h('button', { type: 'button', className: 'key key-small', textContent: 'Reset trim', onclick: () => setRegion(0, duration, true) });
  const toPads = h('button', { type: 'button', className: 'key key-small key-go', onclick: () => sendSlices() });
  const truncate = confirmButton(h('button', { type: 'button', className: 'key key-small', title: 'Cut the sample down to S–E for good. Chops are kept. This can’t be undone.' }), {
    label: 'Truncate',
    confirmLabel: 'Cut for good?',
    onConfirm: () => truncateToTrim()
  });
  const done = h('button', { type: 'button', className: 'key key-small', textContent: 'Done', onclick: () => close() });

  const el = h(
    'div',
    { className: 'editor', hidden: true },
    h('div', { className: 'editor-head' }, title, resetTrim, truncate, done),
    canvas,
    overview,
    readout,
    h('div', { className: 'editor-tools' }, play, chopKey, hits, sens),
    h('div', { className: 'editor-tools' }, split, snapLabel, clearChops),
    h('div', { className: 'editor-tools editor-send' }, toPads)
  );

  const size = () => canvas.getBoundingClientRect();
  const span = () => viewEnd - viewStart;
  const xOf = (t, w) => ((t - viewStart) / span()) * w;
  const tOf = (x, w) => clamp(viewStart + (x / w) * span(), 0, duration);
  const zoomed = () => viewStart > 0 || viewEnd < duration;
  const bpm = () => getState()?.pads[index]?.clip?.bpm ?? null;

  function snapped(t) {
    return clamp(snapTime(t, { data, sampleRate: record.sampleRate, zero: snap.checked }), 0, duration);
  }

  function buildColumns(w) {
    const n = Math.max(1, Math.floor(w));
    const from = viewStart * record.sampleRate;
    const per = (span() * record.sampleRate) / n;
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    for (let x = 0; x < n; x++) {
      let lo = 0;
      let hi = 0;
      for (let i = Math.max(0, Math.floor(from + x * per)), stop = Math.min(data.length, Math.floor(from + (x + 1) * per) + 1); i < stop; i++) {
        if (data[i] < lo) lo = data[i];
        if (data[i] > hi) hi = data[i];
      }
      min[x] = lo;
      max[x] = hi;
    }
    return { w: n, key: `${n}:${viewStart}:${viewEnd}`, min, max };
  }

  function setView(s, e) {
    const next = clamp(e - s, Math.min(duration, MIN_VIEW_FRAMES / record.sampleRate), duration);
    viewStart = clamp(s, 0, duration - next);
    viewEnd = viewStart + next;
    columns = null;
    const zoom = duration / next;
    canvas.dataset.zoom = zoom.toFixed(2);
    overview.hidden = !zoomed();
    thumb.style.left = `${(viewStart / duration) * 100}%`;
    thumb.style.width = `${(next / duration) * 100}%`;
    draw();
    return zoom;
  }

  function zoomAt(x, w, factor) {
    const at = tOf(x, w);
    const next = span() * factor;
    const zoom = setView(at - (x / w) * next, at - (x / w) * next + next);
    flash('Zoom', `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`);
  }

  function setGain(next) {
    gain = clamp(next, 1, MAX_GAIN);
    canvas.dataset.amp = gain.toFixed(2);
    draw();
  }

  function resetView() {
    setView(0, duration);
  }

  const redraw = hiDpiCanvas(canvas, (ctx, w, hgt) => paint(ctx, w, hgt));
  function draw() {
    if (record) redraw();
  }

  function paint(ctx, w, hgt) {
    if (!data) return;
    if (!columns || columns.key !== `${Math.floor(w)}:${viewStart}:${viewEnd}`) columns = buildColumns(w);
    const mid = hgt / 2;
    const scale = (mid - 6) * gain;
    const color = cssVar('--pad', canvas) || '#4cc9f0';
    const tempo = bpm();
    if (tempo) {
      const beat = 60 / tempo;
      for (let b = Math.max(1, Math.ceil(viewStart / beat)); b * beat < Math.min(duration, viewEnd); b++) {
        ctx.fillStyle = b % 4 === 0 ? 'rgba(214, 246, 255, 0.2)' : 'rgba(214, 246, 255, 0.07)';
        ctx.fillRect(Math.round(xOf(b * beat, w)), 0, 1, hgt);
      }
    }
    ctx.fillStyle = 'rgba(214, 246, 255, 0.1)';
    ctx.fillRect(0, mid, w, 1);
    const xs = xOf(start, w);
    const xe = xOf(end, w);
    for (let x = 0; x < columns.w; x++) {
      ctx.fillStyle = x >= xs && x <= xe ? color : 'rgba(154, 152, 143, 0.45)';
      const top = clamp(mid - columns.max[x] * scale, 0, hgt);
      const bottom = clamp(mid - columns.min[x] * scale, 0, hgt);
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, clamp(xs, 0, w), hgt);
    ctx.fillRect(clamp(xe, 0, w), 0, w - clamp(xe, 0, w), hgt);

    ctx.font = '600 10px Bahnschrift, "DIN Alternate", Arial, sans-serif';
    ctx.textBaseline = 'top';
    const points = [start, ...chops, end];
    points.slice(0, -1).forEach((t, i) => {
      if (points.length <= 2) return;
      ctx.fillStyle = 'rgba(228, 225, 216, 0.75)';
      ctx.fillText(String(i + 1), xOf(t, w) + 4, 4);
    });
    for (const t of chops) {
      const x = Math.round(xOf(t, w));
      ctx.fillStyle = drag?.kind === 'chop' && drag.t === t ? '#ffffff' : 'rgba(228, 225, 216, 0.85)';
      ctx.fillRect(x, 0, 1, hgt);
    }
    for (const [t, label, left] of [[start, 'S', false], [end, 'E', true]]) {
      const x = Math.round(xOf(t, w));
      ctx.fillStyle = '#d6f6ff';
      ctx.fillRect(left ? x - 2 : x, 0, 2, hgt);
      ctx.fillRect(left ? x - 14 : x, hgt - 14, 14, 14);
      ctx.fillStyle = '#050607';
      ctx.fillText(label, left ? x - 11 : x + 4, hgt - 12);
    }
    const at = head();
    if (at !== null) {
      ctx.fillStyle = '#f0533f';
      ctx.fillRect(Math.round(xOf(at, w)), 0, 2, hgt);
    }
    if (gain > 1) {
      const label = `Amp ${gain.toFixed(1)}×`;
      const width = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(5, 6, 7, 0.75)';
      ctx.fillRect(w - width - 10, 16, width + 8, 14);
      ctx.fillStyle = 'rgba(214, 246, 255, 0.85)';
      ctx.fillText(label, w - width - 6, 18);
    }
  }

  function position() {
    if (!playhead) return start;
    const latency = getState()?.latency ?? 0;
    return clamp(playhead.offset + Math.max(0, (performance.now() - playhead.t0) / 1000 - latency), playhead.offset, playhead.offset + playhead.duration);
  }

  // Where the pad itself is playing, carried forward from the last meter reading.
  function padPosition() {
    if (!padHead) return null;
    const elapsed = (performance.now() - padHead.t0) / 1000;
    if (elapsed > PAD_HEAD_STALE_S) return null;
    const { at, rate, start: from, end: to, loop } = padHead;
    const t = at + elapsed * rate;
    if (!loop) return Math.min(t, to);
    return t < to ? t : from + ((t - from) % (to - from));
  }

  function head() {
    return playhead ? position() : padPosition();
  }

  function animate() {
    cancelAnimationFrame(raf);
    const tick = () => {
      const latency = getState()?.latency ?? 0;
      if (playhead && (performance.now() - playhead.t0) / 1000 > playhead.duration + latency) {
        playhead = null;
        play.textContent = 'Play';
      }
      draw();
      raf = playhead || padPosition() !== null ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  }

  function followPad(next) {
    const was = padHead;
    padHead = next && record ? { ...next, t0: performance.now() } : null;
    if (padHead && !raf) animate();
    else if (was && !padHead && !playhead) draw();
  }

  function audition(from, to) {
    playhead = { t0: performance.now(), offset: from, duration: to - from };
    play.textContent = 'Stop';
    send(MSG.PREVIEW, { index, start: from, end: to });
    animate();
  }

  function stopPlay() {
    if (!playhead) return;
    playhead = null;
    play.textContent = 'Play';
    send(MSG.STOP_PREVIEW);
    draw();
  }

  function togglePlay() {
    if (playhead) stopPlay();
    else audition(start, end);
  }

  function updateReadout() {
    const slices = slicesFrom(start, end, chops);
    readout.replaceChildren(
      h('span', { textContent: `Start ${fmt(start)}` }),
      h('span', { textContent: `Length ${fmt(end - start)}` }),
      h('span', { textContent: slices.length > 1 ? `${slices.length} slices` : 'No chops' })
    );
    toPads.textContent = slices.length > 1 ? `Send ${slices.length} slices to pads` : 'Send slices to pads';
    toPads.disabled = slices.length < 2;
    clearChops.disabled = chops.length === 0;
    resetTrim.disabled = start === 0 && end === duration;
    truncate.disabled = resetTrim.disabled;
  }

  async function truncateToTrim() {
    if (!record || (start === 0 && end === duration)) return;
    clearTimeout(saveTimer);
    stopPlay();
    const target = index;
    const length = end - start;
    const next = truncateClip(record, start, end, chops);
    try {
      await putClip(next);
      await send(MSG.PAD_STORED, { index: target });
      showStatus(`Truncated ${padLabel(target)} to ${fmt(length)}.`, 'info');
    } catch (err) {
      showStatus(`Couldn't truncate the sample: ${err.message}`);
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    const target = index;
    const snapshot = { start, end, chops: [...chops] };
    saveTimer = setTimeout(async () => {
      const current = await getClip(target);
      if (current?.channels?.length && current.name === record?.name) await putClip({ ...current, ...snapshot });
    }, SAVE_DELAY_MS);
  }

  function setChops(next, message) {
    chops = cleanChops(next, start, end);
    updateReadout();
    draw();
    persist();
    if (message) flash('Chop', message === 'Chops cleared' ? message : `${message}, ${slicesFrom(start, end, chops).length} slices`);
  }

  function setRegion(s, e, commit) {
    start = clamp(s, 0, duration - MIN_SLICE_SECONDS);
    end = clamp(e, start + MIN_SLICE_SECONDS, duration);
    chops = cleanChops(chops, start, end);
    updateReadout();
    draw();
    if (commit) {
      send(MSG.SET_PAD_REGION, { index, start, end });
      persist();
    }
  }

  function chopAtPlayhead() {
    if (!record) return false;
    const at = head();
    if (at === null) {
      showStatus('Press Play (or play the pad) first, then tap G on each hit you want to cut at.', 'info');
      return true;
    }
    const t = snapped(at);
    if (t <= start || t >= end) return true;
    setChops([...chops, t]);
    flash('Chop', `${slicesFrom(start, end, chops).length} slices`);
    return true;
  }

  function findHits() {
    const found = detectTransients(record.channels, record.sampleRate, { start, end, sensitivity: SENSITIVITY[sensitivity], max: 16 });
    if (!found.length) {
      showStatus('No clear hits found in this sample. Try More hits, or split it evenly.', 'info');
      return;
    }
    setChops(found, 'Found hits');
  }

  async function sendSlices() {
    const slices = slicesFrom(start, end, chops);
    const state = getState();
    if (slices.length < 2 || !state) return;
    const free = freePadsAfter(state.pads, index);
    if (free.length < slices.length) {
      showStatus(`${slices.length} slices need ${slices.length} empty pads and ${free.length} are free. Clear some pads or remove chops.`);
      return;
    }
    toPads.disabled = true;
    const targets = free.slice(0, slices.length);
    try {
      for (const [i, slice] of slices.entries()) {
        const channels = extractSlice(record.channels, record.sampleRate, slice.start, slice.end);
        await putClip({ index: targets[i], name: `${record.name}`.slice(0, 34) + ` ${i + 1}`, bpm: bpm(), sampleRate: record.sampleRate, channels });
        await send(MSG.PAD_STORED, { index: targets[i] });
        await send(MSG.UPDATE_PAD, { index: targets[i], changes: { mode: 'One-shot' } });
      }
      showStatus(`Sent ${slices.length} slices to pads ${padLabel(targets[0])}–${padLabel(targets[targets.length - 1])} as one-shots.`, 'info');
      onSlicesSent(targets);
    } catch (err) {
      showStatus(`Couldn't save the slices: ${err.message}`);
    } finally {
      updateReadout();
    }
  }

  function hit(x, w) {
    if (Math.abs(x - xOf(start, w)) <= HIT_PX) return { kind: 'start' };
    if (Math.abs(x - xOf(end, w)) <= HIT_PX) return { kind: 'end' };
    let best = null;
    for (const t of chops) {
      const d = Math.abs(x - xOf(t, w));
      if (d <= HIT_PX && (!best || d < best.d)) best = { kind: 'chop', t, d };
    }
    return best;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      if (!record || !zoomed()) return;
      grab = { pointerId: e.pointerId, x: e.clientX, from: viewStart };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (!record || e.button !== 0) return;
    const { left, width } = size();
    const x = e.clientX - left;
    const target = hit(x, width);
    if (target) {
      canvas.setPointerCapture(e.pointerId);
      drag = target;
      return;
    }
    if (e.shiftKey || e.altKey) return;
    const t = tOf(x, width);
    const slice = slicesFrom(start, end, chops).find((s) => t >= s.start && t < s.end);
    if (slice) audition(slice.start, slice.end);
    else audition(t, duration);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!record) return;
    if (grab) {
      if (e.pointerId !== grab.pointerId) return;
      const moved = -((e.clientX - grab.x) / size().width) * span();
      setView(grab.from + moved, grab.from + moved + span());
      return;
    }
    const { left, width } = size();
    const x = e.clientX - left;
    if (!drag) {
      canvas.style.cursor = hit(x, width) ? 'ew-resize' : 'pointer';
      return;
    }
    const t = snapped(tOf(x, width));
    if (drag.kind === 'start') setRegion(Math.min(t, end - MIN_SLICE_SECONDS), end, false);
    else if (drag.kind === 'end') setRegion(start, Math.max(t, start + MIN_SLICE_SECONDS), false);
    else {
      const moved = clamp(t, start + MIN_SLICE_SECONDS, end - MIN_SLICE_SECONDS);
      chops = chops.map((c) => (c === drag.t ? moved : c)).sort((a, b) => a - b);
      drag.t = moved;
      updateReadout();
      draw();
    }
  });

  const endDrag = () => {
    if (grab) {
      grab = null;
      canvas.style.cursor = '';
      return;
    }
    if (!drag) return;
    const kind = drag.kind;
    drag = null;
    if (kind === 'chop') setChops(chops);
    else setRegion(start, end, true);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('dblclick', (e) => {
    if (!record) return;
    if (e.shiftKey || e.altKey) {
      if (e.shiftKey) resetView();
      if (e.altKey) setGain(1);
      flash('View', e.shiftKey && e.altKey ? 'Reset' : e.shiftKey ? 'Zoom reset' : 'Amp reset');
      return;
    }
    const { left, width } = size();
    const x = e.clientX - left;
    const target = hit(x, width);
    if (target?.kind === 'chop') {
      setChops(chops.filter((c) => c !== target.t));
      return;
    }
    if (target) return;
    const t = snapped(tOf(x, width));
    if (t > start && t < end) setChops([...chops, t]);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!record) return;
      const { left, width } = size();
      const delta = e.deltaY || e.deltaX;
      if (e.shiftKey) {
        e.preventDefault();
        zoomAt(e.clientX - left, width, Math.exp(delta * ZOOM_RATE));
      } else if (e.altKey) {
        e.preventDefault();
        setGain(gain * Math.exp(-delta * AMP_RATE));
        flash('Amp', `${gain.toFixed(1)}×`);
      } else if (zoomed() && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView(viewStart + (e.deltaX / width) * span(), viewEnd + (e.deltaX / width) * span());
      }
    },
    { passive: false }
  );

  overview.addEventListener('pointerdown', (e) => {
    if (!record || e.button !== 0) return;
    const { left, width } = overview.getBoundingClientRect();
    const t = ((e.clientX - left) / width) * duration;
    if (t < viewStart || t > viewEnd) setView(t - span() / 2, t + span() / 2);
    pan = { pointerId: e.pointerId, x: e.clientX, from: viewStart };
    overview.setPointerCapture(e.pointerId);
  });
  overview.addEventListener('pointermove', (e) => {
    if (pan?.pointerId !== e.pointerId) return;
    const shift = ((e.clientX - pan.x) / overview.getBoundingClientRect().width) * duration;
    setView(pan.from + shift, pan.from + shift + span());
  });
  for (const type of ['pointerup', 'pointercancel']) {
    overview.addEventListener(type, () => {
      pan = null;
    });
  }

  async function load(next) {
    let found = null;
    for (let i = 0; i < LOAD_TRIES && !found?.channels?.length; i++) {
      found = await getClip(next);
      if (!found?.channels?.length) await wait(150);
    }
    if (index !== next) return;
    if (!found?.channels?.length) {
      showStatus(`Pad ${padLabel(next)} couldn't be opened for editing. Try recording or loading it again.`);
      close();
      return;
    }
    record = found;
    data = mono(found.channels);
    duration = data.length / found.sampleRate;
    columns = null;
    setGain(1);
    resetView();
    const clip = getState()?.pads[next]?.clip;
    start = clip?.start ?? found.start ?? 0;
    end = clip?.end ?? found.end ?? duration;
    chops = cleanChops(found.chops ?? [], start, end);
    title.replaceChildren(h('strong', { textContent: `Editing ${padLabel(next)}` }), h('span', { className: 'pad-clip', textContent: found.name, title: found.name }));
    updateReadout();
    draw();
  }

  function open(next) {
    stopPlay();
    padHead = null;
    padPlaying = Boolean(getState()?.pads[next]?.playing);
    index = next;
    record = null;
    data = null;
    clipKey = JSON.stringify([getState()?.pads[next]?.clip?.name, getState()?.pads[next]?.clip?.duration]);
    title.replaceChildren(h('strong', { textContent: `Editing ${padLabel(next)}` }), h('span', { className: 'dim', textContent: 'Loading…' }));
    readout.replaceChildren();
    el.hidden = false;
    load(next);
  }

  function close() {
    if (index === null) return;
    stopPlay();
    cancelAnimationFrame(raf);
    raf = 0;
    padHead = null;
    index = null;
    record = null;
    data = null;
    el.hidden = true;
    onClose();
  }

  function update(state) {
    if (index === null) return;
    const clip = state.pads[index]?.clip;
    if (!clip) {
      close();
      return;
    }
    const key = JSON.stringify([clip.name, clip.duration]);
    if (key !== clipKey) open(index);
    // Pressing the pad stops the editor's preview in the engine, so follow the pad from here.
    const playing = Boolean(state.pads[index].playing);
    if (playing && !padPlaying) halt();
    padPlaying = playing;
  }

  function halt() {
    if (!playhead) return;
    playhead = null;
    play.textContent = 'Play';
    draw();
  }

  return { el, open, close, update, chopAtPlayhead, halt, followPad, isOpen: () => index !== null, editing: () => index };
}
