import { AudioEngine } from '../engine/engine.js';
import { PRESETS } from '../engine/presets.js';
import { loadWorklets } from '../effects/registry.js';
import { MSG, TARGET } from '../shared/messages.js';
import { bufferFromRecord, clipRecord, deleteClip, getAllClips, getClip, putClip } from '../shared/pad-store.js';
import { PAD_COUNT, settingsFrom } from '../shared/state.js';

const METER_INTERVAL_MS = 80;
const MODULATION_INTERVAL_MS = 20;
const SETTINGS_DELAY_MS = 250;
const SETTINGS_KEY = 'engineSettings';
const PENDING_KEY = 'pendingTabs';
const MENU_CAPTURE = 'firefox404-capture';
const CAPTURE_PORT = 'firefox404-capture';
const STREAM_TARGET_MS = 60;

const ctx = new AudioContext({ latencyHint: 'interactive' });
const tabs = new Map();
let settingsTimer = null;

function broadcast(message) {
  browser.runtime.sendMessage({ target: TARGET.BROADCAST, ...message }).catch(() => {});
}

function reportError(err, kind = 'error') {
  browser.storage.session.set({ lastError: { message: String(err?.message ?? err), kind, at: Date.now() } });
}

function saveSettings(state) {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => browser.storage.local.set({ [SETTINGS_KEY]: settingsFrom(state) }), SETTINGS_DELAY_MS);
}

const engine = new AudioEngine(ctx, {
  onChange: (state) => {
    broadcast({ type: MSG.STATE, state });
    saveSettings(state);
  },
  onClip: (index, buffer, meta) => putClip(clipRecord(index, buffer, meta)).catch(reportError)
});

async function restorePads() {
  for (const record of await getAllClips()) {
    if (record?.channels?.length) engine.setPadClip(record.index, bufferFromRecord(ctx, record), record);
  }
}

const ready = (async () => {
  await loadWorklets(ctx);
  await ctx.audioWorklet.addModule(new URL('../engine/worklets/stream-processor.js', import.meta.url));
  await engine.startTempoDetection();
  await engine.startRecorder();
  const saved = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? null;
  engine.applySettings(saved);
  await restorePads().catch(reportError);
})();

function isCapturable(tab) {
  return /^(https?|file):/.test(tab?.url ?? '');
}

async function updatePending(change) {
  const stored = await browser.storage.session.get(PENDING_KEY);
  await browser.storage.session.set({ [PENDING_KEY]: change(stored[PENDING_KEY] ?? []) });
}

function pendingEntry(tab) {
  return { tabId: tab.id, windowId: tab.windowId, title: tab.title || `Tab ${tab.id}` };
}

async function captureTab(tab) {
  ctx.resume();
  await ready;
  if (!isCapturable(tab)) throw new Error('Firefox-404 can only capture web pages (http, https or file addresses).');
  if (!engine.hasTab(tab.id)) await browser.tabs.executeScript(tab.id, { file: '/capture/capture.js', allFrames: true, matchAboutBlank: true });
  await updatePending((list) => list.filter((p) => p.tabId !== tab.id));
}

function tabEntry(tab) {
  let entry = tabs.get(tab.id);
  if (!entry) {
    const input = ctx.createGain();
    entry = { input, ports: new Map(), media: new Map(), stats: null, tap: null };
    tabs.set(tab.id, entry);
    engine.addSource(input, { id: `tab-${tab.id}`, kind: 'tab', label: tab.title || `Tab ${tab.id}`, tabId: tab.id });
  }
  return entry;
}

function dropTab(tabId, { release = false } = {}) {
  const entry = tabs.get(tabId);
  if (!entry) return;
  tabs.delete(tabId);
  for (const [port, player] of entry.ports) {
    player.disconnect();
    if (!release) continue;
    try {
      port.postMessage({ type: 'release' });
      port.disconnect();
    } catch {}
  }
  engine.removeSource(`tab-${tabId}`);
}

function removeSource({ sourceId }) {
  const meta = engine.findSource(sourceId);
  if (meta?.tabId != null && tabs.has(meta.tabId)) dropTab(meta.tabId, { release: true });
  else engine.removeSource(sourceId);
}

function checkMedia(tab) {
  setTimeout(() => {
    const entry = tabs.get(tab.id);
    if (!entry) return;
    const found = [...entry.media.values()].reduce((sum, n) => sum + n, 0);
    if (!found) reportError(`No audio or video player found on “${tab.title}” yet. Firefox-404 picks it up as soon as one starts playing.`, 'info');
  }, 500);
}

function connectCapture(port) {
  const tab = port.sender?.tab;
  if (port.name !== CAPTURE_PORT || !tab) return;
  let player = null;
  port.onMessage.addListener((message) => {
    if (message.type === 'audio') {
      player?.port.postMessage({ l: message.l, r: message.r }, [message.l.buffer, message.r.buffer]);
    } else if (message.type === 'ready') {
      const entry = tabEntry(tab);
      player = new AudioWorkletNode(ctx, 'firefox404-stream', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sourceRate: message.sampleRate, targetMs: STREAM_TARGET_MS }
      });
      player.port.onmessage = ({ data }) => {
        entry.stats = data;
      };
      player.connect(entry.input);
      entry.ports.set(port, player);
      entry.media.set(port, message.media);
      entry.tap = message.tap;
      entry.tapError = message.tapError;
      checkMedia(tab);
    } else if (message.type === 'media') {
      tabs.get(tab.id)?.media.set(port, message.count);
    } else if (message.type === 'blocked') {
      reportError(`Firefox needs one click on “${tab.title}” before Firefox-404 can hear it. Click anywhere on that page.`, 'info');
    } else if (message.type === 'error') {
      reportError(message.message);
    }
  });
  port.onDisconnect.addListener(() => {
    player?.disconnect();
    const entry = tabs.get(tab.id);
    if (!entry) return;
    entry.ports.delete(port);
    entry.media.delete(port);
    if (!entry.ports.size) dropTab(tab.id);
  });
}

function streamStats() {
  return Object.fromEntries([...tabs].map(([tabId, entry]) => [tabId, { ...entry.stats, tap: entry.tap, tapError: entry.tapError }]));
}

function heardTime(at) {
  const transit = Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 1000) : 0;
  return ctx.currentTime - transit - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
}

async function loadStoredPad({ index }) {
  const record = await getClip(index);
  if (!record?.channels?.length) throw new Error('That sample could not be read back. Try loading it again.');
  engine.setPadClip(index, bufferFromRecord(ctx, record), record);
}

function padIndices({ index, indices }) {
  return (Array.isArray(indices) ? indices : [index]).filter((i) => Number.isInteger(i) && i >= 0 && i < PAD_COUNT);
}

function updatePads(message) {
  engine.batch(() => padIndices(message).forEach((i) => engine.updatePad(i, message.changes)));
}

async function setPadBpm(message) {
  const values = new Map();
  engine.batch(() => padIndices(message).forEach((i) => values.set(i, engine.setPadBpm(i, message.bpm))));
  for (const [index, value] of values) {
    if (value === undefined) continue;
    const record = await getClip(index);
    if (record?.channels?.length) await putClip({ ...record, bpm: value });
  }
}

async function transferPad({ from, to, mode }) {
  const [source, target] = await Promise.all([getClip(from), getClip(to)]);
  if (!engine.transferPad(from, to, mode)) throw new Error('That pad has no sample to move.');
  if (source?.channels?.length) await putClip({ ...source, index: to });
  if (mode === 'swap' && target?.channels?.length) await putClip({ ...target, index: from });
  else if (mode !== 'copy') await deleteClip(from);
}

async function clearPads(message) {
  const indices = padIndices(message);
  engine.batch(() => indices.forEach((i) => engine.clearPad(i)));
  for (const index of indices) await deleteClip(index);
}

const handlers = {
  [MSG.GET_STATE]: () => {},
  [MSG.CAPTURE_TAB]: ({ tabId }) => browser.tabs.get(tabId).then(captureTab),
  [MSG.STREAM_STATS]: () => {},
  [MSG.REMOVE_SOURCE]: removeSource,
  [MSG.UPDATE_SOURCE]: ({ sourceId, changes }) => engine.updateSource(sourceId, changes),
  [MSG.ADD_SLOT]: ({ busId, effectId }) => engine.addSlot(busId, effectId, { recall: true }),
  [MSG.SWAP_SLOT]: ({ busId, slot, effectId }) => engine.swapSlot(busId, slot, effectId),
  [MSG.REMOVE_SLOT]: ({ busId, slot }) => engine.removeSlot(busId, slot),
  [MSG.MOVE_SLOT]: ({ busId, slot, delta }) => engine.moveSlot(busId, slot, delta),
  [MSG.SET_SLOT_ENABLED]: ({ busId, slot, enabled }) => engine.setSlotEnabled(busId, slot, enabled),
  [MSG.SET_BUS_ENGAGED]: ({ busId, engaged }) => engine.setBusEngaged(busId, engaged),
  [MSG.SET_PARAM]: ({ busId, slot, paramId, value }) => engine.setParam(busId, slot, paramId, value),
  [MSG.SET_LFO]: ({ busId, slot, changes }) => engine.setLfo(busId, slot, changes),
  [MSG.SET_INPUT_ROUTE]: ({ route }) => engine.setInputRoute(route),
  [MSG.SET_PAD_ROUTE]: ({ route }) => engine.setPadRoute(route),
  [MSG.SET_BUS_ROUTING]: ({ routing }) => engine.setBusRouting(routing),
  [MSG.SET_BPM]: ({ bpm }) => engine.setBpm(bpm),
  [MSG.TAP]: ({ bpm, beat, at }) => engine.tap({ bpm, beat, time: heardTime(at) }),
  [MSG.SET_AUTO_BPM]: ({ enabled }) => engine.setAutoBpm(enabled),
  [MSG.SET_QUANTIZE]: ({ quantize }) => engine.setQuantize(quantize),
  [MSG.SET_MASTER]: ({ level }) => engine.setMaster(level),
  [MSG.SET_CROSSFADER]: ({ value }) => engine.setCrossfader(value),
  [MSG.PAD_PRESS]: async ({ index }) => {
    await ctx.resume();
    engine.padPress(index);
  },
  [MSG.PAD_RELEASE]: async ({ index }) => {
    await ctx.resume();
    engine.padRelease(index);
  },
  [MSG.STOP_PADS]: () => engine.stopPads(),
  [MSG.UPDATE_PAD]: updatePads,
  [MSG.CLEAR_PAD]: clearPads,
  [MSG.PAD_STORED]: loadStoredPad,
  [MSG.START_RECORDING]: async ({ pad, length }) => {
    await ctx.resume();
    if (engine.state.recording) throw new Error('A recording is already running. Stop it before starting another.');
    if (!engine.startRecording({ pad, length })) throw new Error('Recording could not start. Reload the extension and try again.');
  },
  [MSG.STOP_RECORDING]: () => engine.stopRecording(),
  [MSG.SET_PAD_REGION]: ({ index, start, end }) => engine.setPadRegion(index, start, end),
  [MSG.SET_PAD_BPM]: setPadBpm,
  [MSG.TRANSFER_PAD]: transferPad,
  [MSG.STOP_PAD]: ({ index }) => engine.stopPad(index),
  [MSG.PREVIEW]: async ({ index, start, end }) => {
    await ctx.resume();
    engine.setLatency((ctx.outputLatency || 0) + (ctx.baseLatency || 0));
    if (!engine.preview(index, start, end)) throw new Error('That pad has no audio to play.');
  },
  [MSG.STOP_PREVIEW]: () => engine.stopPreview(),
  [MSG.LOAD_PRESET]: ({ presetId, preset }) => {
    if (PRESETS[presetId]) engine.loadPreset(PRESETS[presetId]);
    else if (preset && typeof preset === 'object') engine.loadPreset(preset);
  }
};

browser.runtime.onMessage.addListener((message) => {
  if (message.target === TARGET.BACKGROUND && message.type === MSG.ENSURE_ENGINE) return ready.then(() => ({ ok: true }));
  if (message.target !== TARGET.OFFSCREEN) return undefined;
  const handler = handlers[message.type];
  if (!handler) return undefined;
  return ready
    .then(() => handler(message))
    .then(
      () => ({ ok: true, result: message.type === MSG.STREAM_STATS ? streamStats() : engine.snapshot() }),
      (err) => ({ ok: false, error: String(err?.message ?? err) })
    );
});

browser.runtime.onConnect.addListener(connectCapture);

async function captureFromUser(tab) {
  try {
    await captureTab(tab);
    await browser.storage.session.remove('lastError');
  } catch (err) {
    reportError(err);
  }
}

function openAndCapture(tab) {
  browser.sidebarAction.open().catch(() => {});
  captureFromUser(tab);
}

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({ id: MENU_CAPTURE, title: 'Capture this tab in Firefox-404', contexts: ['page', 'audio', 'video'] });
});

browser.browserAction.onClicked.addListener(openAndCapture);

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_CAPTURE && tab) openAndCapture(tab);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.audible === undefined && changeInfo.title === undefined) return;
  if (changeInfo.audible === false) {
    await updatePending((list) => list.filter((p) => p.tabId !== tabId));
    return;
  }
  if (!tab.audible || !isCapturable(tab) || tabs.has(tabId)) return;
  await updatePending((list) => [...list.filter((p) => p.tabId !== tabId), pendingEntry(tab)]);
});

browser.tabs.onRemoved.addListener((tabId) => {
  updatePending((list) => list.filter((p) => p.tabId !== tabId));
  dropTab(tabId);
});

function busy() {
  return engine.state.sources.length > 0 || engine.state.recording !== null || engine.state.pads.some((p) => p.playing);
}

setInterval(() => {
  if (busy()) broadcast({ type: MSG.METER, level: engine.level(), transport: engine.transport() });
}, METER_INTERVAL_MS);

setInterval(() => engine.tickModulation(ctx.currentTime), MODULATION_INTERVAL_MS);
