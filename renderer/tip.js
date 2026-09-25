// Tip window: shows the appreciation QR code.
//
// The image ships inside the asar, so it is handed over as bytes and shown via
// a blob: URL — the same path every other image in this app takes. Pointing an
// <img> at a file:// path would need 'self' in the CSP, and file:// origins are
// opaque in Chromium, so that is not reliable.
"use strict";

const qr = document.getElementById("qr");

window.petHost.tipImage().then((bytes) => {
  if (!bytes || !bytes.length) {
    qr.remove();
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "赞赏码图片缺失";
    document.body.append(note);
    return;
  }
  qr.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}).catch(() => {});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.closeTip();
});

// Fit the window to the content, the same way the settings window does.
requestAnimationFrame(() => {
  const chrome = window.outerHeight - window.innerHeight;
  window.petHost.fitTip(document.documentElement.scrollHeight + chrome);
});
