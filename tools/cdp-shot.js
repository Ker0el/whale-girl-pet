// Capture the renderer's own surface over CDP, independent of whether the OS
// window is visible, occluded, or composited. Distinguishes "renderer paints
// nothing" from "window is not shown on screen".
// Usage: node cdp-shot.js <ws-url> <out.png>
"use strict";

const fs = require("node:fs");
const [, , wsUrl, out] = process.argv;

const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 20000);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png", fromSurface: true } }));
});

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== 1) return;
  clearTimeout(timer);
  if (msg.error) {
    console.error("CDP error:", JSON.stringify(msg.error));
    process.exit(1);
  }
  const data = msg.result && msg.result.data;
  if (!data) {
    console.error("no data");
    process.exit(1);
  }
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log("saved", out, Buffer.from(data, "base64").length, "bytes");
  process.exit(0);
});

ws.addEventListener("error", (e) => {
  clearTimeout(timer);
  console.error("ws error:", e && e.message ? e.message : e);
  process.exit(1);
});
