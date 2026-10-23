import fs from 'node:fs/promises';
import path from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Connect only to the isolated review editor started by test-editor.mjs. The
// session uses a disposable profile; no user editor settings are inspected.
export async function reviewIcons(directory, port, signal) {
  const deadline = Date.now() + 110000;
  let socket, sequence = 0;
  const pending = new Map();
  async function connect() {
    while (!signal.aborted && Date.now() < deadline) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = pages.find(p => p.type === 'page' && /workbench/.test(p.url));
        if (page) {
          socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
          socket.addEventListener('message', event => {
            const message = JSON.parse(event.data), operation = pending.get(message.id);
            if (operation) {pending.delete(message.id); message.error ? operation.reject(new Error(message.error.message)) : operation.resolve(message.result);}
          });
          return;
        }
      } catch { /* The editor's debugger endpoint is not ready yet. */ }
      await pause(200);
    }
    throw new Error('Isolated editor debugger endpoint did not become available.');
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => {pending.delete(id); reject(new Error('Editor review timed out: ' + method));}, 10000);
    pending.set(id, {resolve: result => {clearTimeout(timer); resolve(result);}, reject: error => {clearTimeout(timer); reject(error);}});
    socket.send(JSON.stringify({id, method, params}));
  });
  try {
    await connect();
    const completed = new Set();
    while (!signal.aborted && Date.now() < deadline) {
      let request;
      try {request = JSON.parse(await fs.readFile(path.join(directory, 'review-request.json'), 'utf8'));} catch {await pause(100); continue;}
      if (completed.has(request.name)) {await pause(100); continue;}
      const expected = request.name === 'override' ? 'override.svg' : `kelft-icon-${request.name}.svg`;
      let observation;
      const ready = Date.now() + 15000;
      do {
        const evaluation = await send('Runtime.evaluate', {returnByValue: true, expression: `JSON.stringify({theme:document.body.className, explorer:[...document.querySelectorAll('.explorer-viewlet .kelft-lang-file-icon')].map(e=>({text:e.textContent,icon:getComputedStyle(e,'::before').backgroundImage})), tabs:[...document.querySelectorAll('.tab .kelft-lang-file-icon')].map(e=>({text:e.textContent,icon:getComputedStyle(e,'::before').backgroundImage}))})`});
        observation = JSON.parse(evaluation.result.value);
        if (observation.explorer.some(e => e.text.includes('main.kelft') && e.icon.includes(expected)) && observation.tabs.some(e => e.text.includes('main.kelft') && e.icon.includes(expected))) break;
        await pause(200);
      } while (!signal.aborted && Date.now() < ready);
      const status = observation.explorer.some(e => e.text.includes('main.kelft') && e.icon.includes(expected)) && observation.tabs.some(e => e.text.includes('main.kelft') && e.icon.includes(expected)) ? 'passed' : 'failed';
      const screenshot = await send('Page.captureScreenshot', {format: 'png'});
      await fs.writeFile(path.join(directory, `icons-${request.name}.png`), Buffer.from(screenshot.data, 'base64'));
      await fs.writeFile(path.join(directory, 'review-' + request.name + '.json'), JSON.stringify({status, expected, ...observation}, null, 2) + '\n');
      completed.add(request.name);
      if (status !== 'passed') throw new Error('Explorer/tab icon review failed: ' + request.name);
      if (completed.size === 3) return;
    }
    if (!signal.aborted) throw new Error('Icon review did not finish.');
  } finally {socket?.close();}
}
