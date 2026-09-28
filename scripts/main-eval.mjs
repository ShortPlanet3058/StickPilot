// Development aid: evaluate JS in the Electron main process.
// Start the app with: npx electron . --inspect=9229
// Usage: node scripts/main-eval.mjs "<js>"   (Electron's require is available as `r`)
const [target] = await (await fetch('http://127.0.0.1:9229/json')).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const expr = `(async () => { const r = process.mainModule.require; return (${process.argv[2]}); })()`;
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
const msg = await new Promise((r) => ws.addEventListener('message', (e) => r(JSON.parse(e.data)), { once: true }));
console.log(JSON.stringify(msg.result?.result?.value ?? msg.result));
ws.close();
