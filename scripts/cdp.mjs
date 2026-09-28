// Development aid: drive the running app over the Chrome DevTools protocol.
// Start the app with: npx electron . --remote-debugging-port=9223
// Usage: node scripts/cdp.mjs eval "<js>"   |   node scripts/cdp.mjs shot out.png
import { writeFileSync } from 'fs';

const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const call = (method, params = {}) => new Promise((resolve) => {
  const my = ++id;
  const onMsg = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === my) { ws.removeEventListener('message', onMsg); resolve(m.result ?? m.error); }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: my, method, params }));
});
if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.value ?? r));
} else if (cmd === 'click') {
  // Real mouse click at CSS pixel coordinates: node scripts/cdp.mjs click <x> <y>
  const [x, y] = [Number(arg), Number(process.argv[4])];
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  console.log('clicked', x, y);
} else if (cmd === 'keys') {
  // Real key presses: node scripts/cdp.mjs keys ArrowUp Enter w i f i Escape
  const codes = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Backspace: 8 };
  for (const key of process.argv.slice(3)) {
    const vk = codes[key] ?? key.toUpperCase().charCodeAt(0);
    const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, text, windowsVirtualKeyCode: vk });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log('keys sent');
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log('saved', arg);
}
ws.close();
