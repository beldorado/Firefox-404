// Loads the extension in Firefox, drives the sidebar page and checks the Perform view and tab capture end to end.
// Usage: SELENIUM=<selenium-webdriver> FIREFOX=<firefox.exe> node tests/run-extension.cjs [screenshot-dir]
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createPage } = require('./webdriver-page.cjs');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
const ADDON_ID = 'firefox-404@beldorado';
const UUID = '0b0e4f04-4040-4040-8404-f1aef0a40400';
if (!process.env.SELENIUM || !process.env.FIREFOX) {
  console.error('Set SELENIUM (path to a selenium-webdriver package) and FIREFOX (path to firefox.exe).');
  process.exit(2);
}
const selenium = require(process.env.SELENIUM);
const firefox = require(path.join(process.env.SELENIUM, 'firefox'));

function toneWav(seconds = 4, rate = 48000, frequency = 440, amplitude = 0.003) {
  const frames = seconds * rate;
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / rate) * 32767);
    data.writeInt16LE(v, 44 + i * 4);
    data.writeInt16LE(v, 46 + i * 4);
  }
  return data;
}

function serveTone() {
  const wav = toneWav();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/tone.wav')) res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav);
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Tone page</title><audio id="a" src="/tone.wav" loop></audio>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function openPanel(driver) {
  const before = new Set(await driver.getAllWindowHandles());
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(
    `const win = Services.wm.getMostRecentWindow('navigator:browser');
    win.gBrowser.selectedTab = win.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`,
    `moz-extension://${UUID}/sidepanel/sidepanel.html`
  );
  await driver.setContext(firefox.Context.CONTENT);
  await driver.wait(async () => (await driver.getAllWindowHandles()).some((h) => !before.has(h)), 10000);
  const handle = (await driver.getAllWindowHandles()).find((h) => !before.has(h));
  await driver.switchTo().window(handle);
  return handle;
}

function drumWav(bpm, bars, rate = 48000) {
  const frames = Math.round((bars * 4 * 60 * rate) / bpm);
  const left = new Float32Array(frames);
  const beat = (60 * rate) / bpm;
  for (let b = 0; b < bars * 4; b++) {
    const at = Math.round(b * beat);
    for (let i = 0; i < rate * 0.25 && at + i < frames; i++) {
      const t = i / rate;
      left[at + i] += (b % 2 === 0 ? 0.8 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) : 0.35 * (Math.random() * 2 - 1)) * Math.exp(-t * (b % 2 === 0 ? 9 : 22));
    }
  }
  const data = Buffer.alloc(44 + frames * 4);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, left[i])) * 32767);
    data.writeInt16LE(v, 44 + i * 4);
    data.writeInt16LE(v, 46 + i * 4);
  }
  return data;
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'firefox404-'));
  const downloads = path.join(profile, 'downloads');
  fs.mkdirSync(downloads);
  const wav = path.join(profile, 'Boom loop.wav');
  fs.writeFileSync(wav, drumWav(100, 1));
  const server = await serveTone();
  const options = new firefox.Options()
    .setBinary(process.env.FIREFOX)
    .addArguments('-headless')
    .setPreference('media.volume_scale', '0.0')
    .setPreference('media.autoplay.default', 0)
    .setPreference('media.autoplay.block-webaudio', false)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }))
    .setPreference('browser.download.folderList', 2)
    .setPreference('browser.download.dir', downloads)
    .setPreference('browser.download.useDownloadDir', true)
    .setPreference('browser.download.always_ask_before_handling_new_types', false)
    .setPreference('browser.helperApps.neverAsk.saveToDisk', 'audio/wav,audio/x-wav,audio/wave,application/octet-stream');
  const driver = await new selenium.Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
    .build();
  await driver.manage().setTimeouts({ script: 60000 });
  const page = createPage(driver, selenium, { downloads });
  let errors = [];
  try {
    await driver.installAddon(ROOT, true);
    const panelHandle = await openPanel(driver);
    await page.setViewportSize({ width: 380, height: 1100 });
    await page.waitForFunction(() => document.querySelectorAll('.pad').length === 12 && document.querySelector('#bpm').value !== '');
    await page.collectErrors();
    const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    const engine = (type, payload = {}) => page.evaluate(([type, payload]) => browser.runtime.sendMessage({ target: 'offscreen', type, ...payload }), [type, payload]);

    check('Perform view is the default', await page.evaluate(() => document.body.dataset.view === 'perform' && !document.getElementById('perform').hidden && document.getElementById('edit').hidden));
    check('Six bus FX buttons and twelve pads render, keyed Q to V', (await page.locator('.fx').count()) === 6 && (await page.locator('.pad').count()) === 12 && (await page.$$eval('.pad .pad-key', (ks) => ks.map((k) => k.textContent).join(''))) === 'QWERASDFZXCV');
    await shot('01-empty');

    await page.selectOption('#preset', 'classic');
    await page.waitForFunction(() => document.querySelector('.fx[data-bus="bus4"]').classList.contains('lit'));
    check('Loading the classic preset lights Bus 4 and Master', await page.evaluate(() => ['bus4', 'master'].every((b) => document.querySelector(`.fx[data-bus="${b}"]`).classList.contains('lit'))));

    await page.keyboard.press('Digit4');
    await page.waitForFunction(() => !document.querySelector('.fx[data-bus="bus4"]').classList.contains('lit'));
    check('Tapping key 4 switches Bus 4 off', true);
    check('Tapping a bus selects it for the CTRL knobs', await page.evaluate(() => document.querySelector('.ctrl-bus').textContent === 'Bus 4' && document.querySelectorAll('.ctrl-knob').length === 3));
    check('Bus 4 chain shows chips for its three effects', (await page.locator('.chip').count()) === 3);

    await page.keyboard.down('Digit4');
    await page.waitForFunction(() => document.querySelector('.fx[data-bus="bus4"]').classList.contains('lit'));
    await page.waitForTimeout(450);
    await page.keyboard.up('Digit4');
    await page.waitForFunction(() => !document.querySelector('.fx[data-bus="bus4"]').classList.contains('lit'));
    check('Holding key 4 plays Bus 4 only while held', true);

    const fx1 = page.locator('.fx[data-bus="bus1"]');
    await fx1.click();
    check('Clicking an empty bus selects it and offers an effect picker', await page.evaluate(() => document.querySelector('.ctrl-bus').textContent === 'Bus 1' && document.querySelector('.ctrl-effect').value === ''));
    await page.selectOption('.ctrl-effect', 'filter-drive');
    await page.waitForFunction(() => document.querySelectorAll('.ctrl-knob').length === 3);
    check('Choosing an effect adds it and shows Cutoff, Reso, Drive', (await page.locator('.ctrl-knob label').allTextContents()).join() === 'Cutoff,Reso,Drive');

    const knob = page.locator('.ctrl-knob').first();
    const box = await knob.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 30, { steps: 6 });
    await page.mouse.up();
    const state = await engine('get-state');
    const cutoff = state.result.buses.bus1.slots[0].params.cutoff;
    check('Dragging CTRL 1 up raises the cutoff', cutoff > 1200, `${Math.round(cutoff)} Hz`);
    check('The screen shows the last touched control', /Cutoff/.test(await page.textContent('#readout-name')), await page.textContent('#readout'));

    await page.selectOption('.ctrl-effect', 'lofi');
    await page.waitForFunction(() => document.querySelector('.ctrl-knob label')?.textContent === 'Rate');
    await page.selectOption('.ctrl-effect', 'filter-drive');
    await page.waitForFunction(() => document.querySelector('.ctrl-knob label')?.textContent === 'Cutoff');
    const recalled = (await engine('get-state')).result.buses.bus1.slots[0].params.cutoff;
    check('Swapping away and back keeps the cutoff (effect memory)', Math.abs(recalled - cutoff) < 1e-6, `${Math.round(recalled)} Hz`);

    await page.click('#quantize');
    await page.waitForFunction(() => document.querySelector('#quantize').textContent === 'Q 1/8');
    check('Quantize key cycles 1/16 → 1/8', true);

    await page.locator('.pad').nth(2).click();
    await page.setInputFiles('.bank input[type="file"]', wav);
    await page.waitForFunction(() => document.querySelectorAll('.pad')[2].classList.contains('loaded'));
    check('Loading a WAV fills the selected pad with its name and waveform', await page.evaluate(() => {
      const pad = document.querySelectorAll('.pad')[2];
      return pad.querySelector('.pad-name').textContent === 'Boom loop' && pad.querySelector('path').getAttribute('d').length > 100;
    }));
    check('Imported samples cannot follow BPM (no tempo known)', await page.evaluate(() => document.querySelector('.pad-options input[type="checkbox"]').disabled));

    await page.fill('[data-role="pad-bpm"]', '135');
    await page.press('[data-role="pad-bpm"]', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.pad-options input[type="checkbox"]').disabled);
    check('Typing a BPM on the pad turns Follow BPM on', await page.evaluate(() => document.querySelector('.pad-options input[type="checkbox"]').checked && document.querySelector('[data-role="pad-bpm"]').value === '135'));
    await shot('03-pad-bpm');
    await page.fill('[data-role="pad-bpm"]', '');
    await page.press('[data-role="pad-bpm"]', 'Enter');
    await page.waitForFunction(() => document.querySelector('.pad-options input[type="checkbox"]').disabled);
    check('Clearing the pad BPM disables Follow BPM again', true);

    await page.selectOption('[data-role="pad-choke"]', '2');
    await page.waitForFunction(() => document.querySelectorAll('.pad')[2].querySelector('.pad-group').textContent === 'G2');
    check('Picking a choke group tags the pad', (await engine('get-state')).result.pads[2].choke === 2);
    await shot('03-pad-choke');
    await page.selectOption('[data-role="pad-choke"]', '0');
    await page.waitForFunction(() => document.querySelectorAll('.pad')[2].querySelector('.pad-group').textContent === '');

    await page.keyboard.press('KeyE');
    await page.waitForFunction(() => document.querySelectorAll('.pad')[2].classList.contains('playing'));
    check('Key E starts pad 3 looping', true);
    await page.waitForFunction(() => document.querySelector('#position').textContent !== '–.–', null, { timeout: 4000 });
    check('Beat clock runs while a pad plays', /^\d+\.\d$/.test(await page.textContent('#position')), await page.textContent('#position'));

    await page.keyboard.press('KeyT');
    await page.waitForFunction(() => document.querySelector('.rec').classList.contains('armed') || document.querySelector('.rec').classList.contains('recording'));
    check('T arms a recording into the first empty pad', await page.evaluate(() => document.querySelectorAll('.pad')[0].classList.contains('recording')));
    await shot('02-playing-recording');
    await page.waitForFunction(() => document.querySelectorAll('.pad')[0].classList.contains('loaded'), null, { timeout: 15000 });
    const pads = (await engine('get-state')).result.pads;
    check('One bar is resampled into pad 1 with its BPM', pads[0].clip?.name === '1 bar at 90 BPM' && Math.abs(pads[0].clip.duration - (4 * 60) / 90) < 0.01, JSON.stringify(pads[0].clip?.name));

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pad.playing'));
    check('Esc stops every pad', true);

    const download = page.waitForEvent('download');
    await page.locator('.pad').nth(0).click();
    await page.waitForTimeout(100);
    await page.click('.pad-tools >> text=Export WAV');
    const file = await download;
    const saved = path.join(profile, file.suggestedFilename());
    await file.saveAs(saved);
    const header = fs.readFileSync(saved).subarray(0, 12).toString('latin1');
    check('Export WAV downloads a valid WAV', header.startsWith('RIFF') && header.endsWith('WAVE'), file.suggestedFilename());

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.pad.loaded').length === 2, null, { timeout: 5000 }).catch(() => {});
    check('Pads survive reopening the panel', (await page.locator('.pad.loaded').count()) === 2);

    await page.click('.pad-tools >> text=Clear');
    await page.click('.pad-tools >> text=Clear pad?');
    await page.waitForFunction(() => document.querySelectorAll('.pad.loaded').length === 1);
    check('Clear asks for a second click, then empties the pad', true);
    await shot('03-perform');

    await page.locator('.pad').nth(2).click();
    await page.keyboard.press('Escape');
    await page.click('.pad-tools >> text=Edit / chop');
    await page.waitForFunction(() => !document.querySelector('.editor').hidden && /Length/.test(document.querySelector('.editor-readout').textContent));
    check('Edit / chop opens the waveform editor for the pad', await page.evaluate(() => document.querySelector('.editor-title').textContent.includes('Editing A3') && document.querySelector('.pad-detail').hidden));
    await page.click('.editor >> text=Find hits');
    await page.waitForFunction(() => /slices/.test(document.querySelector('.editor-readout').textContent));
    check('Find hits chops the drum loop at its 3 later hits (4 slices)', /4 slices/.test(await page.textContent('.editor-readout')), await page.textContent('.editor-readout'));

    await page.click('.editor >> text=Play');
    await page.waitForTimeout(350);
    await page.keyboard.press('KeyG');
    await page.waitForFunction(() => /5 slices/.test(document.querySelector('.editor-readout').textContent), null, { timeout: 3000 }).catch(() => {});
    check('Tapping G while it plays drops a chop at the playhead', /5 slices/.test(await page.textContent('.editor-readout')), await page.textContent('.editor-readout'));
    await shot('06-editor');

    const view = () => page.$eval('.wave-graph', (c) => ({ zoom: Number(c.dataset.zoom), amp: Number(c.dataset.amp), overview: !document.querySelector('.wave-overview').hidden, thumb: document.querySelector('.wave-window').style.width, left: parseFloat(document.querySelector('.wave-window').style.left) }));
    const graph = await page.locator('.wave-graph').boundingBox();
    const [gx, gy] = [graph.x + graph.width * 0.6, graph.y + graph.height / 2];
    const slicesBefore = await page.textContent('.editor-readout');
    await page.mouse.move(gx, gy);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, -600);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => Number(document.querySelector('.wave-graph').dataset.zoom) > 1.5);
    const zoomedIn = await view();
    check('Shift+scroll zooms in on the waveform and shows the overview bar', zoomedIn.zoom > 1.5 && zoomedIn.overview && parseFloat(zoomedIn.thumb) < 70, JSON.stringify(zoomedIn));
    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, -500);
    await page.keyboard.up('Alt');
    await page.waitForFunction(() => Number(document.querySelector('.wave-graph').dataset.amp) > 1.5);
    check('Alt+scroll zooms the amplitude', (await view()).amp > 1.5, JSON.stringify(await view()));
    const beforeGrab = await view();
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(gx - 80, gy, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    const afterGrab = await view();
    check('Holding the scroll wheel and dragging left moves later into the sample, keeping the zoom', afterGrab.left > beforeGrab.left + 5 && afterGrab.zoom === beforeGrab.zoom && (await page.textContent('.editor-readout')) === slicesBefore, `view starts at ${beforeGrab.left.toFixed(1)}% → ${afterGrab.left.toFixed(1)}%`);
    await page.mouse.move(gx, gy);
    await shot('06-editor-zoom');
    await page.keyboard.down('Shift');
    await page.mouse.dblclick(gx, gy);
    await page.keyboard.up('Shift');
    const timeReset = await view();
    check('Shift+double-click resets the time zoom and keeps the amplitude', timeReset.zoom === 1 && !timeReset.overview && timeReset.amp > 1.5 && (await page.textContent('.editor-readout')) === slicesBefore, JSON.stringify(timeReset));
    await page.keyboard.down('Alt');
    await page.mouse.dblclick(gx, gy);
    await page.keyboard.up('Alt');
    check('Alt+double-click resets the amplitude without adding a chop', (await view()).amp === 1 && (await page.textContent('.editor-readout')) === slicesBefore, await page.textContent('.editor-readout'));

    await page.click('.editor-send .key');
    await page.waitForFunction(() => document.querySelectorAll('.pad.loaded').length === 6, null, { timeout: 8000 });
    const sliced = (await engine('get-state')).result.pads;
    const slicePads = [3, 4, 5, 6, 7].map((i) => sliced[i]);
    check('Send slices fills pads A4–A8 with one-shots named after the source', slicePads.every((p, n) => p.clip?.name === `Boom loop ${n + 1}` && p.mode === 'One-shot'), slicePads.map((p) => `${p.clip?.name}/${p.mode}`).join(', '));
    const total = slicePads.reduce((sum, p) => sum + p.clip.duration, 0);
    check('Slices add up to the whole sample', Math.abs(total - sliced[2].clip.duration) < 0.002, `${total.toFixed(4)} s vs ${sliced[2].clip.duration.toFixed(4)} s`);

    const wave = await page.locator('.wave-graph').boundingBox();
    await page.mouse.move(wave.x + 2, wave.y + wave.height / 2);
    await page.mouse.down();
    await page.mouse.move(wave.x + wave.width * (0.45 / 2.4), wave.y + wave.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const trimmed = (await engine('get-state')).result.pads[2].clip;
    check('Dragging S trims the start without changing the audio', Math.abs(trimmed.start - 0.45) < 0.02 && trimmed.end === trimmed.duration, `start ${trimmed.start.toFixed(3)} s of ${trimmed.duration.toFixed(3)} s`);
    check('Trimming drops the chop that falls before the new start', /4 slices/.test(await page.textContent('.editor-readout')), await page.textContent('.editor-readout'));

    await page.click('.editor >> text=Done');
    check('Done closes the editor and brings back the pad details', await page.evaluate(() => document.querySelector('.editor').hidden && !document.querySelector('.pad-detail').hidden));

    const padStates = async (from, to) => (await engine('get-state')).result.pads.slice(from, to);
    const untilPads = async (test, ms = 5000) => {
      const start = Date.now();
      while (!test((await engine('get-state')).result.pads)) {
        if (Date.now() - start > ms) throw new Error('Timed out waiting for the pads to change');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await page.locator('.pad').nth(3).click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => document.querySelector('.pad-title strong').textContent === 'Pad A4');
    check('Shift+click selects a pad without playing it', (await padStates(3, 4))[0].playing === false && (await page.locator('.pad').nth(3).getAttribute('class')).includes('selected'));
    await page.locator('.pad').nth(4).click({ modifiers: ['Control'] });
    await page.locator('.pad').nth(5).click({ modifiers: ['Control'] });
    await page.waitForFunction(() => document.querySelector('.pad-title strong').textContent === '3 pads');
    check('Ctrl+click adds pads to the selection without playing them', (await padStates(3, 6)).every((p) => !p.playing) && (await page.locator('.bank.multi .pad.selected').count()) === 3, await page.textContent('.pad-chips'));
    await page.click('.pad-detail [data-mode="Gate"]');
    await page.selectOption('[data-role="pad-choke"]', '1');
    await page.fill('[data-role="pad-bpm"]', '120');
    await page.press('[data-role="pad-bpm"]', 'Enter');
    await page.waitForFunction(() => document.querySelector('.pad-options input[type="checkbox"]').checked);
    await page.$eval('[data-role="pad-level"]', (el) => {
      el.value = '0.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await untilPads((pads) => pads[5].level === 0.5);
    const edited = await padStates(3, 7);
    check(
      'Edits apply to every selected pad and no others',
      edited.slice(0, 3).every((p) => p.mode === 'Gate' && p.choke === 1 && p.clip.bpm === 120 && p.sync && p.level === 0.5) && edited[3].mode === 'One-shot' && edited[3].choke === 0 && edited[3].clip.bpm === null,
      JSON.stringify(edited.map((p) => [p.mode, p.choke, p.clip.bpm, p.level]))
    );
    await page.locator('.pad').nth(6).click({ modifiers: ['Control'] });
    await page.waitForFunction(() => document.querySelector('[data-role="pad-bpm"]').placeholder === 'Mixed');
    check('Mixed values show as mixed when the selection differs', await page.evaluate(() => document.querySelector('[data-role="pad-bpm"]').value === '' && document.querySelector('[data-role="pad-choke"]').value === '' && [...document.querySelectorAll('.pad-detail [data-mode]')].every((b) => b.getAttribute('aria-checked') === 'false')));
    await shot('03-multi-select');
    await page.click('.pad-chip >> text=A5');
    await page.waitForFunction(() => document.querySelector('.pad-title strong').textContent === '3 pads');
    check('Clicking a pad tag takes it out of the selection', (await page.textContent('.pad-chips')).replace(/×/g, '') === 'A4A6A7', await page.textContent('.pad-chips'));
    await page.locator('.pad').nth(3).click();
    await page.waitForFunction(() => document.querySelector('.pad-title strong').textContent === 'Pad A4');
    check('A plain click goes back to a single pad', (await page.locator('.bank.multi').count()) === 0 && (await page.locator('.pad.selected').count()) === 1);

    const dragPad = async (from, to, { quiet = true } = {}) => {
      const a = await page.locator('.pad').nth(from).boundingBox();
      const b = await page.locator('.pad').nth(to).boundingBox();
      if (quiet) await page.keyboard.down('Shift');
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
      await page.mouse.up();
      if (quiet) await page.keyboard.up('Shift');
      await page.waitForSelector('dialog.transfer[open]');
    };
    const choices = () => page.$$eval('dialog.transfer[open] .transfer-actions button', (bs) => bs.map((b) => b.textContent).join());
    const names = async () => (await padStates(0, 8)).map((p) => p.clip?.name ?? null);
    const empty = (await names()).indexOf(null);
    await dragPad(3, empty);
    check('Dropping a pad on an empty pad asks Move, Copy or Cancel', (await choices()) === 'Move,Copy,Cancel' && (await page.evaluate(() => document.activeElement.textContent === 'Move')), await choices());
    await page.click('dialog.transfer .transfer-actions >> text="Copy"');
    await untilPads((pads) => pads[empty].clip !== null);
    const copied = await padStates(0, 8);
    check('Copy fills the target with the sample and its settings and keeps the source', copied[empty].clip.name === 'Boom loop 1' && copied[empty].mode === 'Gate' && copied[empty].choke === 1 && copied[3].clip.name === 'Boom loop 1', `${copied[empty].clip.name}, ${copied[empty].mode}, group ${copied[empty].choke}`);

    await dragPad(4, 3);
    check('Dropping on a pad that holds a sample also offers Swap', (await choices()) === 'Move,Copy,Swap,Cancel', await choices());
    await page.waitForTimeout(200);
    await shot('08-drag-pad');
    await page.click('dialog.transfer .transfer-actions >> text="Swap"');
    await untilPads((pads) => pads[3].clip?.name === 'Boom loop 2');
    check('Swap trades the two pads', (await names())[4] === 'Boom loop 1', (await names()).slice(3, 5).join(' / '));

    await dragPad(empty, 7);
    await page.click('dialog.transfer .transfer-actions >> text="Move"');
    await untilPads((pads) => pads[empty].clip === null);
    const stored = await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('chrome404');
      open.onsuccess = () => {
        const request = open.result.transaction('pads').objectStore('pads').getAll();
        request.onsuccess = () => resolve(request.result.map((r) => [r.index, r.name]));
      };
    }));
    check('Move replaces the target, empties the source and is saved', (await names())[7] === 'Boom loop 1' && !stored.some(([i]) => i === empty) && stored.some(([i, n]) => i === 7 && n === 'Boom loop 1'), JSON.stringify(stored));

    await dragPad(3, 4, { quiet: false });
    const playing = (await padStates(3, 4))[0].playing;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.transfer[open]'));
    check('A plain drag stops the pad it started, and Esc cancels the drop', playing === false && (await names()).slice(3, 5).join() === 'Boom loop 2,Boom loop 1', `playing ${playing}`);
    await page.keyboard.press('KeyB');
    await page.waitForFunction(() => document.querySelector('.pad .pad-num').textContent === 'B1');
    check('B switches to pad bank B', await page.evaluate(() => [...document.querySelectorAll('.bank-switch button')].map((b) => b.getAttribute('aria-checked')).join() === 'false,true'));
    await page.keyboard.press('KeyB');
    await page.waitForFunction(() => document.querySelector('.pad .pad-num').textContent === 'A1');

    await page.click('#view-edit');
    check('Edit view shows the chain editor and hides Perform', await page.evaluate(() => !document.getElementById('edit').hidden && document.getElementById('perform').hidden && document.querySelectorAll('.bus').length >= 3));
    check('Edit view has a bus on/off switch per bus', (await page.locator('.bus [data-role="engage"]').count()) >= 3);
    await page.click('#routing [data-routing="Series"]');
    await page.waitForFunction(() => document.querySelector('#routing [data-routing="Series"]').getAttribute('aria-checked') === 'true');
    check('Bus routing switches to series', (await engine('get-state')).result.busRouting === 'Series' && (await page.textContent('#routing-hint')).startsWith('Bus 1 → Bus 2'));
    await shot('04-edit');
    await page.click('#routing [data-routing="Parallel"]');
    await page.waitForFunction(() => document.querySelector('#routing [data-routing="Parallel"]').getAttribute('aria-checked') === 'true');
    await page.click('#view-perform');

    await page.selectOption('#preset', 'glitchKit');
    await page.waitForFunction(() => document.querySelector('.fx[data-bus="bus4"]').classList.contains('lit') && document.querySelector('.fx[data-bus="bus1"] .fx-effect').textContent === 'DJ Looper');
    check('Glitch kit loads with buses 1–3 ready but dark', await page.evaluate(() => ['bus1', 'bus2', 'bus3'].every((b) => !document.querySelector(`.fx[data-bus="${b}"]`).classList.contains('lit'))));

    const fxShape = async () => {
      const { buses } = (await engine('get-state')).result;
      return JSON.stringify(Object.entries(buses).map(([id, b]) => [id, b.engaged, b.slots.map((s) => [s.effect, s.enabled, s.params])]));
    };
    const kitShape = await fxShape();
    await page.click('#save-preset');
    check('Save opens a name box with focus in it', await page.evaluate(() => !document.getElementById('preset-form').hidden && document.activeElement === document.querySelector('#preset-form input')));
    await page.keyboard.type('My kit');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('preset-form').hidden && [...document.querySelectorAll('#preset optgroup[label="Saved"] option')].some((o) => o.textContent === 'My kit'));
    check('Saving adds the preset to the menu under Saved', true);
    await page.selectOption('#preset', 'init');
    await page.waitForFunction(() => !document.querySelector('.fx[data-bus="bus4"]').classList.contains('lit'));
    const mine = await page.evaluate(() => [...document.querySelectorAll('#preset option')].find((o) => o.textContent === 'My kit').value);
    await page.selectOption('#preset', mine);
    await page.waitForFunction(() => document.querySelector('.fx[data-bus="bus1"] .fx-effect').textContent === 'DJ Looper');
    check('Loading a saved preset brings back the whole FX setup', (await fxShape()) === kitShape);
    await page.click('#save-preset');
    await page.keyboard.type('my KIT');
    check('Typing an existing name offers to replace it', (await page.textContent('#preset-form button[type="submit"]')) === 'Replace');
    await shot('07-save-preset');
    await page.click('.preset-tag-delete');
    await page.click('.preset-tag-delete');
    await page.waitForFunction(() => !document.querySelector('#preset optgroup[label="Saved"]'));
    check('Deleting a preset takes two clicks and removes it', (await page.evaluate(() => browser.storage.local.get('userPresets'))).userPresets.length === 0);
    await page.click('#preset-form >> text=Cancel');
    check('Cancel closes the name box', await page.evaluate(() => document.getElementById('preset-form').hidden));
    const fx2 = page.locator('.fx[data-bus="bus2"]');
    const b2 = await fx2.boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.fx[data-bus="bus2"]').classList.contains('lit'));
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.fx[data-bus="bus2"]').classList.contains('lit'));
    check('Holding the Bus 2 button with the mouse plays Stopper only while held', true);
    check('Clicking a bus button does not steal keyboard focus', await page.evaluate(() => !document.activeElement?.classList.contains('fx')));

    await page.locator('.pad').nth(5).click();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('#readout-name').textContent === 'Tap');
    check('Space taps tempo even right after clicking a pad or tab', true, await page.textContent('#readout-value'));
    check('…and does not switch views or press the focused tab', await page.evaluate(() => document.body.dataset.view === 'perform'));
    await page.evaluate(() => window.addEventListener('keydown', (e) => (window.__spaceTaken = e.code === 'Space' && e.defaultPrevented)));
    await page.keyboard.press('Space');
    const mouseFocusTaken = await page.evaluate(() => window.__spaceTaken);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.className);
    await page.keyboard.press('Space');
    const tabFocusTaken = await page.evaluate(() => window.__spaceTaken);
    await page.keyboard.press('Escape');
    check('Space is left to a control reached with Tab, but taken as tap after a mouse click', mouseFocusTaken === true && tabFocusTaken === false, `focused ${focused}; mouse-focus taken ${mouseFocusTaken}, tab-focus taken ${tabFocusTaken}`);

    await page.selectOption('#preset', 'init');
    await page.waitForFunction(() => !document.querySelector('.fx.lit'));
    await driver.switchTo().newWindow('tab');
    const toneHandle = await driver.getWindowHandle();
    await driver.get(`http://127.0.0.1:${server.address().port}/tone`);
    await driver.executeScript("document.getElementById('a').play()");
    await driver.switchTo().window(panelHandle);
    await page.waitForFunction(() => !document.getElementById('pending').hidden && document.querySelector('#pending-list .source-label')?.textContent === 'Tone page', null, { timeout: 15000 });
    check('A tab that is playing shows up under Sources with a Capture button', (await page.locator('#pending-list .pending-capture').count()) === 1);
    await page.click('#pending-list .pending-capture');
    await page.waitForFunction(() => [...document.querySelectorAll('#sources .source-label')].some((l) => l.textContent === 'Tone page'), null, { timeout: 15000 });
    check('Capture in the sidebar adds the tab to Sources without switching to it', await page.evaluate(() => document.getElementById('pending').hidden));
    const toneTab = await page.evaluate(async () => (await browser.tabs.query({})).find((t) => t.title === 'Tone page').id);
    const contentStatus = () => page.evaluate(async (id) => JSON.parse((await browser.tabs.executeScript(id, { code: 'JSON.stringify(window.firefox404Capture.status())' }))[0]), toneTab);
    await page.waitForTimeout(1500);
    const stream = (await engine('stream-stats')).result[toneTab];
    const peak = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let max = 0;
          const listen = (m) => {
            if (m.type === 'meter') max = Math.max(max, m.level.peak);
          };
          browser.runtime.onMessage.addListener(listen);
          setTimeout(() => {
            browser.runtime.onMessage.removeListener(listen);
            resolve(max);
          }, 800);
        })
    );
    check('The tab’s audio reaches the engine through the worklet tap without dropouts', stream?.tap === 'worklet' && stream.underruns === 0 && peak > 0.001, `${stream?.tap}, ${stream?.bufferedMs?.toFixed(0)} ms buffered, ${stream?.underruns} underruns, peak ${peak.toFixed(4)}`);
    check('The page now plays through Firefox-404 instead of on its own', (await contentStatus()).live === true);
    await shot('07-captured');
    await page.click('#sources .source-remove');
    await page.waitForFunction(() => !document.querySelector('#sources .source'));
    check('Removing the source gives the page its own audio back', (await contentStatus()).live === false);
    await engine('capture-tab', { tabId: toneTab });
    await page.waitForFunction(() => document.querySelectorAll('#sources .source').length === 1, null, { timeout: 15000 });
    check('The same tab can be captured again', (await contentStatus()).live === true);
    await driver.switchTo().window(toneHandle);
    await driver.close();
    await driver.switchTo().window(panelHandle);
    await page.waitForFunction(() => !document.querySelector('#sources .source'), null, { timeout: 15000 });
    check('Closing a captured tab removes its source', true);

    await page.setViewportSize({ width: 320, height: 1100 });
    await shot('05-narrow');
    const overflow = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth || document.body.getBoundingClientRect().right > document.documentElement.getBoundingClientRect().right + 0.5);
    check('Nothing overflows horizontally at 320 px', !overflow);
  } catch (err) {
    check('Runner crashed', false, err.stack);
  } finally {
    errors = await page.errors().catch(() => []);
    const benign = errors.filter((e) => !/Receiving end does not exist|Could not establish connection/.test(e));
    check('No page errors', benign.length === 0, benign.join(' | '));
    await driver.quit();
    server.close();
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n== extension: ${results.length - failed}/${results.length}`);
    process.exitCode = failed ? 1 : 0;
  }
})();
