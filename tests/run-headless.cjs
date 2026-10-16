const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const SUITES = process.argv.slice(2).length ? process.argv.slice(2) : ['filter-smoke', 'tempo-smoke', 'fx-smoke', 'perform-smoke'];

if (!process.env.PUPPETEER || !process.env.FIREFOX) {
  console.error('Set PUPPETEER (path to a puppeteer-core package) and FIREFOX (path to firefox.exe).');
  process.exit(2);
}
const puppeteer = require(process.env.PUPPETEER);

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const server = await serve();
  const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX, headless: true, extraPrefsFirefox: { 'media.cubeb.force_null_context': true, 'media.autoplay.default': 0 } });
  const page = await browser.newPage();
  const errors = [];
  let crash = null;
  page.on('pageerror', (e) => {
    errors.push(String(e));
    crash?.(e);
  });
  let failed = 0;
  for (const suite of SUITES) {
    const crashed = new Promise((_, reject) => {
      crash = (e) => reject(new Error(`${suite} crashed: ${e}`));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/${suite}.html`);
    await Promise.race([page.waitForFunction(() => window.__smoke, { timeout: 300000 }), crashed]);
    const result = await page.evaluate(() => window.__smoke);
    console.log(`\n== ${suite}: ${result.passed}/${result.total}`);
    for (const t of result.results) console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}  —  ${t.detail}`);
    failed += result.total - result.passed;
  }
  if (errors.length) console.log(`\nPage errors:\n${errors.join('\n')}`);
  await browser.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error(e);
  setTimeout(() => process.exit(2), 200);
});
