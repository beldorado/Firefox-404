const fs = require('fs');
const path = require('path');

const RESOLVER = `
function __visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}
function __norm(t) {
  return (t || '').replace(/\\s+/g, ' ').trim();
}
function __query(scope, part) {
  part = part.trim();
  const m = /^text=(.*)$/.exec(part);
  if (!m) return [...scope.querySelectorAll(part)];
  let q = m[1].trim();
  const exact = /^".*"$/.test(q);
  if (exact) q = q.slice(1, -1);
  const match = (el) => {
    const t = __norm(el.textContent);
    return exact ? t === q : t.toLowerCase().includes(q.toLowerCase());
  };
  const pool = scope === document ? [...scope.querySelectorAll('*')] : [scope, ...scope.querySelectorAll('*')];
  const hits = pool.filter((el) => match(el) && __visible(el));
  return hits.filter((el) => ![...el.children].some((c) => match(c) && __visible(c)));
}
function __findAll(selector) {
  let scopes = [document];
  for (const part of selector.split('>>')) scopes = scopes.flatMap((s) => __query(s, part));
  return [...new Set(scopes)];
}
`;

const COLLECTOR = `
if (!window.__pageErrors) {
  window.__pageErrors = [];
  addEventListener('error', (e) => window.__pageErrors.push(String(e.message || e)));
  addEventListener('unhandledrejection', (e) => window.__pageErrors.push(String(e.reason && e.reason.stack || e.reason)));
  const original = console.error.bind(console);
  console.error = (...args) => {
    window.__pageErrors.push(args.map(String).join(' '));
    original(...args);
  };
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createPage(driver, selenium, { downloads }) {
  const { Key, Origin, Button } = selenium;
  const KEYS = { Escape: Key.ESCAPE, Enter: Key.ENTER, Space: ' ', Shift: Key.SHIFT, Alt: Key.ALT, Control: Key.CONTROL, Backspace: Key.BACK_SPACE, Tab: Key.TAB };
  const BUTTONS = { left: Button.LEFT, middle: Button.MIDDLE, right: Button.RIGHT };
  const mouse = { x: 0, y: 0 };
  let viewportWidth = null;

  const constrainWidth = () =>
    driver.executeScript(
      `const root = document.documentElement;
      const narrow = arguments[0] && innerWidth > arguments[0];
      root.style.width = narrow ? arguments[0] + 'px' : '';
      root.style.overflowX = narrow ? 'clip' : '';`,
      viewportWidth
    );

  const keyOf = (name) => {
    if (KEYS[name]) return KEYS[name];
    const letter = /^Key([A-Z])$/.exec(name);
    if (letter) return letter[1].toLowerCase();
    const digit = /^Digit(\d)$/.exec(name);
    if (digit) return digit[1];
    return name;
  };

  async function evaluate(fn, arg) {
    const source = typeof fn === 'function' ? fn.toString() : `() => (${fn})`;
    const result = await driver.executeAsyncScript(
      `const done = arguments[arguments.length - 1];
      let value;
      try {
        value = (${source})(arguments[0]);
      } catch (e) {
        done({ e: String((e && e.stack) || e) });
        return;
      }
      Promise.resolve(value).then((v) => done({ v: v === undefined ? null : v }), (e) => done({ e: String((e && e.stack) || e) }));`,
      arg === undefined ? null : arg
    );
    if (result && 'e' in result) throw new Error(result.e);
    return result?.v;
  }

  async function waitForFunction(fn, arg, { timeout = 30000 } = {}) {
    const start = Date.now();
    for (;;) {
      if (await evaluate(fn, arg)) return true;
      if (Date.now() - start > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${String(fn).slice(0, 120)}`);
      await sleep(50);
    }
  }

  const count = (selector) => driver.executeScript(`${RESOLVER} return __findAll(arguments[0]).length;`, selector);

  async function element(selector, index = 0, { visible = true, timeout = 30000 } = {}) {
    const start = Date.now();
    for (;;) {
      const el = await driver.executeScript(
        `${RESOLVER}
        const all = __findAll(arguments[0]).filter((el) => !arguments[2] || __visible(el));
        return all[arguments[1]] || null;`,
        selector,
        index,
        visible
      );
      if (el) return el;
      if (Date.now() - start > timeout) throw new Error(`No element matches ${selector}${index ? ` [${index}]` : ''}`);
      await sleep(50);
    }
  }

  async function settledCenter(el) {
    const read = () => driver.executeScript('const r = arguments[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };', el);
    let rect = await read();
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const next = await read();
      if (Math.abs(next.x - rect.x) < 0.5 && Math.abs(next.y - rect.y) < 0.5) return next;
      rect = next;
    }
    return rect;
  }

  async function clickElement(el, { modifiers = [] } = {}) {
    await driver.executeScript('arguments[0].scrollIntoView({ block: "nearest", inline: "nearest" });', el);
    const rect = await settledCenter(el);
    let actions = driver.actions();
    for (const m of modifiers) actions = actions.keyDown(keyOf(m));
    actions = actions.move({ x: Math.round(rect.x), y: Math.round(rect.y), origin: Origin.VIEWPORT }).click();
    for (const m of modifiers) actions = actions.keyUp(keyOf(m));
    await actions.perform();
    Object.assign(mouse, { x: Math.round(rect.x), y: Math.round(rect.y) });
  }

  function locator(selector, index = 0) {
    return {
      nth: (n) => locator(selector, n),
      first: () => locator(selector, 0),
      click: async (opts) => clickElement(await element(selector, index), opts),
      count: () => count(selector),
      boundingBox: async () => {
        const el = await element(selector, index);
        await driver.executeScript('arguments[0].scrollIntoView({ block: "nearest", inline: "nearest" });', el);
        await settledCenter(el);
        return driver.executeScript('const r = arguments[0].getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };', el);
      },
      getAttribute: async (name) => (await element(selector, index, { visible: false })).getAttribute(name),
      allTextContents: () => driver.executeScript(`${RESOLVER} return __findAll(arguments[0]).map((el) => el.textContent);`, selector)
    };
  }

  const page = {
    evaluate,
    waitForFunction,
    locator: (selector) => locator(selector),
    click: async (selector, opts) => clickElement(await element(selector), opts),
    textContent: async (selector) => driver.executeScript(`${RESOLVER} const el = __findAll(arguments[0])[0]; return el ? el.textContent : null;`, selector),
    fill: async (selector, value) => {
      const el = await element(selector);
      const length = await driver.executeScript('return String(arguments[0].value).length;', el);
      await el.sendKeys(...Array(length).fill(Key.BACK_SPACE), ...(value ? [value] : []));
    },
    press: async (selector, key) => (await element(selector)).sendKeys(keyOf(key)),
    selectOption: async (selector, value) => {
      const el = await element(selector);
      await driver.executeScript(
        `const el = arguments[0];
        el.value = arguments[1];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));`,
        el,
        value
      );
    },
    setInputFiles: async (selector, file) => {
      const el = await element(selector, 0, { visible: false });
      await driver.executeScript('arguments[0].hidden = false; arguments[0].style.display = "block";', el);
      await el.sendKeys(file);
      await driver.executeScript('arguments[0].hidden = true; arguments[0].style.display = ""; arguments[0].blur();', el);
    },
    $eval: (selector, fn, arg) => driver.executeScript(`${RESOLVER} return (${fn.toString()})(__findAll(arguments[0])[0], arguments[1]);`, selector, arg ?? null),
    $$eval: (selector, fn, arg) => driver.executeScript(`${RESOLVER} return (${fn.toString()})(__findAll(arguments[0]), arguments[1]);`, selector, arg ?? null),
    waitForSelector: (selector, { timeout = 30000 } = {}) => element(selector, 0, { timeout }),
    waitForTimeout: sleep,
    keyboard: {
      press: (key) => driver.actions().keyDown(keyOf(key)).keyUp(keyOf(key)).perform(),
      down: (key) => driver.actions().keyDown(keyOf(key)).perform(),
      up: (key) => driver.actions().keyUp(keyOf(key)).perform(),
      type: (text) => driver.actions().sendKeys(text).perform()
    },
    mouse: {
      move: async (x, y, { steps = 1 } = {}) => {
        const from = { ...mouse };
        for (let i = 1; i <= steps; i++) {
          const px = Math.round(from.x + ((x - from.x) * i) / steps);
          const py = Math.round(from.y + ((y - from.y) * i) / steps);
          await driver.actions().move({ x: px, y: py, origin: Origin.VIEWPORT }).perform();
          Object.assign(mouse, { x: px, y: py });
        }
      },
      down: ({ button = 'left' } = {}) => driver.actions().press(BUTTONS[button]).perform(),
      up: ({ button = 'left' } = {}) => driver.actions().release(BUTTONS[button]).perform(),
      wheel: (deltaX, deltaY) => driver.actions().scroll(mouse.x, mouse.y, Math.round(deltaX), Math.round(deltaY), Origin.VIEWPORT).perform(),
      dblclick: async (x, y) => {
        await driver.actions().move({ x: Math.round(x), y: Math.round(y), origin: Origin.VIEWPORT }).doubleClick().perform();
        Object.assign(mouse, { x: Math.round(x), y: Math.round(y) });
      }
    },
    screenshot: async ({ path: file }) => fs.writeFileSync(file, Buffer.from(await driver.takeScreenshot(), 'base64')),
    reload: async () => {
      await driver.executeScript('location.reload();');
      await sleep(300);
      await waitForFunction(() => document.readyState === 'complete');
      await constrainWidth();
      await page.collectErrors();
    },
    setViewportSize: async ({ width, height }) => {
      const inner = await driver.executeScript('return { w: innerWidth, h: innerHeight };');
      const outer = await driver.manage().window().getRect();
      await driver.manage().window().setRect({ width: width + (outer.width - inner.w), height: height + (outer.height - inner.h) });
      viewportWidth = width;
      await constrainWidth();
    },
    waitForEvent: async (type, { timeout = 15000 } = {}) => {
      if (type !== 'download') throw new Error(`Unsupported event ${type}`);
      const before = new Set(fs.readdirSync(downloads));
      const start = Date.now();
      for (;;) {
        const done = fs.readdirSync(downloads).filter((f) => !before.has(f) && !f.endsWith('.part'));
        if (done.length) {
          const name = done[0];
          await sleep(200);
          return { suggestedFilename: () => name, saveAs: async (dest) => fs.copyFileSync(path.join(downloads, name), dest) };
        }
        if (Date.now() - start > timeout) throw new Error('Timed out waiting for a download');
        await sleep(100);
      }
    },
    collectErrors: () => driver.executeScript(COLLECTOR),
    errors: () => driver.executeScript('return window.__pageErrors || [];')
  };
  return page;
}

module.exports = { createPage };
