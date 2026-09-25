// Trigger something via IPC, then screenshot the resulting window — all inside
// one process.
//
// A separate screenshot command cannot do this: launching any console process
// activates it on Windows, which blurs the target window and (for the menu)
// closes it before the capture runs. Doing both here avoids that window
// entirely.
//
// Usage:
//   node win-shot.js <port> <trigger-expression> <trigger-url-part> <capture-url-part> <out.png>
//
// Example:
//   node win-shot.js 9333 "window.petHost.menuCommand('settings')" menu.html settings.html out.png
"use strict";

const fs = require("node:fs");
const [, , port, triggerExpression, triggerPart, capturePart, out, delayArg] = process.argv;
if (!port || !capturePart || !out) {
  console.error("usage: node win-shot.js <port> <trigger-expr> <trigger-url-part> <capture-url-part> <out.png> [delay-ms]");
  process.exit(2);
}
// How long to wait between triggering and capturing. Lower it to catch
// transient paint states such as the moment a window first appears.
const settleMs = Number(delayArg) || 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

function findTarget(list, part) {
  return list.find((t) => t.type === "page" && t.url.includes(part));
}

function rpc(wsUrl, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout: " + method));
    }, timeoutMs || 10000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

(async () => {
  if (triggerExpression && triggerPart) {
    const trigger = findTarget(await targets(), triggerPart);
    if (!trigger) throw new Error("trigger window not found: " + triggerPart);
    await rpc(trigger.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: triggerExpression,
      returnByValue: true
    });
    await sleep(1200);
  }

  const target = findTarget(await targets(), capturePart);
  if (!target) throw new Error("capture window not found: " + capturePart);

  const state = await rpc(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression:
      "JSON.stringify({visible: document.visibilityState, focused: document.hasFocus()," +
      " w: outerWidth, h: outerHeight, x: screenX, y: screenY, innerH: innerHeight," +
      " scrollH: document.documentElement.scrollHeight," +
      " overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight," +
      " overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth})",
    returnByValue: true
  });
  console.log("state:", state.result && state.result.value);

  const shot = await rpc(target.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png", fromSurface: true }, 15000);
  if (!shot || !shot.data) throw new Error("no screenshot data");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved", out, Buffer.from(shot.data, "base64").length, "bytes");
  process.exit(0);
})().catch((e) => {
  console.error("failed:", e && e.message ? e.message : e);
  process.exit(1);
});
