import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Run after npm run build with node scripts/browser-check.mjs.
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), 'peerreview-interactions-'));
await mkdir(artifacts, { recursive: true });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (filename.includes('..')) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(root, filename));
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'peerreview-chrome-'));
const binary = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!binary) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable');
const chrome = spawn(binary, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(100); }
  }
  assert(port, 'Chrome debugging port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  let heldConnections = [];
  let failSearch = true;
  const errors = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const author = recid => ({ record: { $ref: `https://inspirehep.net/api/authors/${recid}` }, full_name: `Author ${recid}`, ids: [{ schema: 'INSPIRE BAI', value: `Author.${recid}` }] });
  const response = items => ({ hits: { total: items.length, hits: items } });
  const fulfill = (event, data) => command('Fetch.fulfillRequest', { requestId: event.requestId,
    responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
    body: Buffer.from(JSON.stringify(data)).toString('base64'),
  });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    else if (message.method === 'Fetch.requestPaused') {
      const event = message.params;
      const url = new URL(event.request.url);
      if (url.pathname.endsWith('/authors')) {
        if (!url.searchParams.get('q').startsWith('control_number:') && failSearch) {
          failSearch = false;
          setTimeout(() => void command('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 503, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }], body: '' }), 150);
          return;
        }
        const data = url.searchParams.get('q').startsWith('control_number:') ? response([]) : response([{
          id: '1', metadata: { control_number: 1, name: { value: 'Root researcher' }, ids: [{ schema: 'INSPIRE BAI', value: 'Author.1' }] },
        }]);
        void fulfill(event, data).catch(error => errors.push(String(error)));
      } else if (!url.searchParams.get('fields').includes('full_name')) heldConnections.push(event);
      else void fulfill(event, response(Array.from({ length: 29 }, (_, i) => ({
        id: `root-${i}`, metadata: { authors: [author(1), author(i + 2), { ...author(999), inspire_roles: ['editor'] }] },
      })))).catch(error => errors.push(String(error)));
    }
  };
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${expression}; ${await evaluate('document.body.innerText')}`);
  };
  const center = selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const click = async selector => {
    const point = await center(selector);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
  await command('Fetch.enable', { patterns: [{ urlPattern: 'https://inspirehep.net/api/*' }] });

  for (const [name, width, mobile] of [['desktop', 1280, false], ['mobile-320', 320, true], ['mobile-375', 375, true]]) {
    heldConnections = [];
    failSearch = true;
    await command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile });
    await command('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await command('Page.navigate', { url: origin });
    await waitFor(`document.querySelector('.search-input') !== null`);
    const coarse = await evaluate(`matchMedia('(pointer: coarse)').matches`);
    assert.equal(coarse, mobile, 'pointer mode');
    await evaluate(`(() => {const input = document.querySelector('.search-input'); input.focus({preventScroll:true}); input.value='Root'; input.dispatchEvent(new Event('input', {bubbles:true}));})()`);
    await waitFor(`document.querySelector('[role="status"]')?.textContent === 'Searching...'`);
    await waitFor(`document.querySelector('.search-retry') !== null`);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert(await evaluate(`document.activeElement.classList.contains('search-retry')`), 'Retry keyboard focus');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`document.querySelector('[role="option"]') !== null`);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert(await evaluate(`document.activeElement.matches('.search-input')`), 'focus after selection');
    await waitFor(`document.querySelectorAll('.node').length === 30`);
    for (let i = 0; i < 100 && heldConnections.length === 0; i++) await delay(25);
    assert(heldConnections.length > 0, 'connection request held');
    if (mobile) await evaluate(`document.querySelector('.node[data-id="2"]').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
    else await evaluate(`document.querySelector('.node[data-id="2"]').dispatchEvent(new MouseEvent('mouseenter'))`);
    assert(await evaluate(`document.querySelector('.node[data-id="2"]').classList.contains('pulse')`));
    for (const event of heldConnections) await fulfill(event, response([{ id: 'cross', metadata: { authors: [author(2), author(30), { full_name: 'Unresolved author' }] } }]));
    await waitFor(`document.querySelectorAll('.edge').length === 30`);
    assert(await evaluate(`document.querySelector('.node[data-id="30"]').classList.contains('highlighted')`));
    await delay(6100);
    assert(await evaluate(`document.querySelector('#progress').classList.contains('visible') && document.querySelector('#progress').textContent.includes('Partial network')`), 'persistent partial warning');
    const fitted = await evaluate(`(() => {
      const status = document.getElementById('status').getBoundingClientRect();
      const controls = document.getElementById('zoom-controls').getBoundingClientRect();
      return [...document.querySelectorAll('.node')].every(node => {
        const r=node.getBoundingClientRect(); return r.left >= 23 && r.right <= innerWidth-23 && r.top >= status.bottom+23 && r.bottom <= controls.top-23;
      });
    })()`);
    assert(fitted, 'automatic fit within available viewport');
    assert.equal(await evaluate(`document.querySelector('#publication-filter').textContent`), 'Papers with at most 10 authors');
    assert.equal(await evaluate(`document.querySelector('#zoom-reset').getAttribute('aria-label')`), 'Fit graph');
    const bounds = await evaluate(`(() => {const ids=['home','bar-search','theme-toggle','about-btn']; return ids.map(id=>{const e=document.getElementById(id);const r=e.getBoundingClientRect();return {id,x:r.x,width:r.width,right:r.right,display:getComputedStyle(e).display}})})()`);
    assert(bounds.every(b => b.x >= 0 && b.right <= width && b.width > 0 && b.display !== 'none'));
    assert(bounds[0].right <= bounds[1].x && bounds[1].right <= bounds[2].x && bounds[2].right <= bounds[3].x);
    assert(bounds[1].width >= 150, 'usable search width');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.home-icon')).display`), mobile ? 'block' : 'none');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.wordmark-text')).display`), mobile ? 'none' : 'inline');
    await evaluate(`document.querySelector('#graph-container svg').dispatchEvent(new MouseEvent('click'))`);
    assert.equal(await evaluate(`document.querySelectorAll('.highlighted,.dimmed,.pulse').length`), 0);
    const screenshot = await command('Page.captureScreenshot');
    await writeFile(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    const graphPoint = await center('.node[data-id="1"]');
    await command('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaY: -400, deltaX: 0, ...graphPoint });
    await delay(100);
    assert(await evaluate(`document.querySelector('#graph-container svg').__zoom.k > 0`));
    await click('#zoom-reset');
    await delay(500);
    await click('#home');
    await waitFor(`document.body.dataset.view === 'landing'`);
    assert.equal(await evaluate(`document.querySelectorAll('.node').length`), 0);
    assert.equal(await evaluate(`document.querySelector('.hero .search-input').value`), '');
    assert(await evaluate(`document.activeElement.matches('.search-input')`), 'focus after home');
    assert.equal(await evaluate(`document.querySelector('#progress').classList.contains('visible')`), false);
    assert(await evaluate(`(() => {const t=document.querySelector('#graph-container svg').__zoom;return t.k===1&&t.x===0&&t.y===0})()`));
    console.log(JSON.stringify({ name, width, coarse, controls: bounds, searchRetryAndFocus: 'passed', liveHighlight: 'passed', partialWarning: 'passed', automaticFit: 'passed', homeAndZoomReset: 'passed' }));
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(`Screenshots: ${artifacts}`);
} finally {
  ws?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await exited;
  }
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
