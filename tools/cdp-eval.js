// Evaluate an expression inside a CDP page target and print the result.
// Usage: node cdp-eval.js <ws-url> "<expression>"
"use strict";

const [, , wsUrl, expression] = process.argv;
if (!wsUrl || !expression) {
  console.error("usage: node cdp-eval.js <ws-url> <expression>");
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 15000);

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true }
    })
  );
});

ws.addEventListener("message", (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch (_) {
    return;
  }
  if (msg.id !== 1) return;
  clearTimeout(timer);
  const r = msg.result || {};
  if (r.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    process.exit(1);
  }
  const v = r.result && r.result.value;
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
  ws.close();
  process.exit(0);
});

ws.addEventListener("error", (e) => {
  clearTimeout(timer);
  console.error("ws error:", e && e.message ? e.message : e);
  process.exit(1);
});
