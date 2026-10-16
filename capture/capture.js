(() => {
  if (window.firefox404Capture) {
    window.firefox404Capture.capture();
    return;
  }

  const PORT_NAME = 'firefox404-capture';
  const CHUNK = 1024;
  const MEDIA = 'audio, video';
  const RESUME_WAIT_MS = 300;

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const mix = ctx.createGain();
  const sources = new Map();
  let port = null;
  let tap = null;
  let live = false;
  let tapError = null;

  function send(message, transfer) {
    try {
      port?.postMessage(message, transfer);
    } catch {}
  }

  function relay(left, right) {
    if (live) send({ type: 'audio', l: left, r: right });
  }

  async function startTap() {
    try {
      await ctx.audioWorklet.addModule(browser.runtime.getURL('capture/tap-processor.js'));
      const node = new AudioWorkletNode(ctx, 'firefox404-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: cloneInto({ chunk: CHUNK }, window)
      });
      node.port.onmessage = ({ data }) => relay(data.l, data.r);
      mix.connect(node).connect(ctx.destination);
      return 'worklet';
    } catch (err) {
      tapError = String(err?.message ?? err);
      const node = ctx.createScriptProcessor(CHUNK * 2, 2, 2);
      node.onaudioprocess = (e) => relay(e.inputBuffer.getChannelData(0).slice(), e.inputBuffer.getChannelData(1).slice());
      mix.connect(node).connect(ctx.destination);
      return 'script';
    }
  }

  function attach(el) {
    if (!live || sources.has(el)) return;
    try {
      const node = ctx.createMediaElementSource(el);
      node.connect(mix);
      sources.set(el, node);
      send({ type: 'media', count: sources.size });
    } catch (err) {
      send({ type: 'error', message: `Firefox-404 couldn't take this page's audio: ${err?.message ?? err}` });
    }
  }

  function scan(root = document) {
    if (root.matches?.(MEDIA)) attach(root);
    root.querySelectorAll?.(MEDIA).forEach(attach);
  }

  new MutationObserver((records) => {
    if (!live) return;
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) scan(node);
  }).observe(document, { childList: true, subtree: true });

  document.addEventListener(
    'play',
    (e) => {
      if (live && /^(AUDIO|VIDEO)$/.test(e.target?.tagName ?? '')) attach(e.target);
    },
    true
  );

  async function begin() {
    live = true;
    tap ??= await startTap();
    for (const node of sources.values()) {
      node.disconnect();
      node.connect(mix);
    }
    scan();
    send({ type: 'ready', sampleRate: ctx.sampleRate, tap, tapError, media: sources.size });
  }

  function release() {
    live = false;
    for (const node of sources.values()) {
      node.disconnect();
      node.connect(ctx.destination);
    }
    const old = port;
    port = null;
    try {
      old?.disconnect();
    } catch {}
  }

  async function capture() {
    if (port) {
      scan();
      return;
    }
    port = browser.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((message) => {
      if (message.type === 'release') release();
    });
    port.onDisconnect.addListener(() => {
      if (port) {
        port = null;
        release();
      }
    });
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
    if (ctx.state === 'running') await begin();
    else send({ type: 'blocked' });
  }

  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'running' && port && !live) begin();
  });
  for (const type of ['pointerdown', 'keydown']) {
    addEventListener(
      type,
      () => {
        if (port && !live) ctx.resume().catch(() => {});
      },
      true
    );
  }

  window.firefox404Capture = { capture, release, status: () => ({ live, state: ctx.state, port: Boolean(port), tap, media: sources.size, elements: document.querySelectorAll(MEDIA).length }) };
  capture();
})();
