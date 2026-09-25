// 鲸鱼娘桌宠 — pet window.
//
// The pet shows exactly one animation: whichever was picked last, looping. It
// does not fall back to anything afterwards, and there is no idle pose to
// return to — picking a reaction replaces what is on screen, and nothing
// changes it back on its own.
"use strict";

const IMG = document.getElementById("pet");

const PET_SIZE_PX = 220;
const MIN_SIZE_PX = 80;
const MAX_SIZE_PX = 640;
const ZOOM_STEP = 1.1;
const CLICK_MOVE_TOLERANCE = 6;
const DBLCLICK_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let size = PET_SIZE_PX;
let currentName = null;

// ---------------------------------------------------------------------------
// Showing an animation
//
// Bytes come from the main process and are re-exposed as a blob: URL. Blob URLs
// inherit this document's origin, so drawing them keeps any canvas readable; a
// file:// page drawing a file:// image taints it.
//
// Each pick creates a new blob URL, and the previous one is revoked — but only
// after the new frame is on screen, because the <img> still points at the old
// URL while it is being replaced. Without this the pet, which runs for days,
// would retain several MB per animation picked.
// ---------------------------------------------------------------------------
let currentUrl = null;

function loadIntoDom(url) {
  return new Promise((resolve) => {
    const done = () => {
      IMG.removeEventListener("load", done);
      IMG.removeEventListener("error", done);
      resolve();
    };
    IMG.addEventListener("load", done);
    IMG.addEventListener("error", done);
    IMG.src = url;
  });
}

async function showAnimation(kind, a, b) {
  const bytes = await window.petHost.asset(kind, a, b);
  if (!bytes || !bytes.length) return;

  const url = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
  const previous = currentUrl;
  currentUrl = url;
  if (kind === "reaction") currentName = a;

  await loadIntoDom(url);
  // The new frame is displayed, so the old URL is safe to free now.
  if (previous) URL.revokeObjectURL(previous);
  updateTrayIcon();
}

/** Show a specific animation from the 蓝色大肥鱼表情包 folder. */
function showReaction(name) {
  if (typeof name !== "string" || !name) return;
  showAnimation("reaction", name).catch(() => {});
}

// ---------------------------------------------------------------------------
// Hit area
//
// The whole window is the target: a square the size of the pet.
//
// An alpha hit test that follows the character's silhouette sounds smarter than
// it feels. GIF frames are mostly transparent, the character moves inside the
// frame as it animates, and the result is a pet you have to aim at. A
// predictable square is easier to hit, and the 鼠标穿透 menu toggle already
// covers the case where the pet sits on top of something you need to click.
// ---------------------------------------------------------------------------
let interactive = null;

function setInteractive(want) {
  if (want === interactive) return;
  interactive = want;
  window.petHost.setInteractive(want);
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------
let dragging = false;
let dragMoved = 0;
let lastScreen = null;
let lastClickAt = 0;

IMG.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragMoved = 0;
  lastScreen = { x: e.screenX, y: e.screenY };
  IMG.classList.add("dragging");
  try {
    IMG.setPointerCapture(e.pointerId);
  } catch (_) {}
});

IMG.addEventListener("pointermove", (e) => {
  if (!dragging || !lastScreen) return;
  // screenX/Y are screen-relative, so they stay correct even though moving the
  // window also moves the pointer's client coordinates.
  const dx = e.screenX - lastScreen.x;
  const dy = e.screenY - lastScreen.y;
  lastScreen = { x: e.screenX, y: e.screenY };
  dragMoved += Math.abs(dx) + Math.abs(dy);
  if (dx || dy) window.petHost.drag(dx, dy);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  lastScreen = null;
  IMG.classList.remove("dragging");
  try {
    IMG.releasePointerCapture(e.pointerId);
  } catch (_) {}

  // A press that barely moved is a click, not a drag. The only thing a click
  // does is count towards a double click; there is deliberately no
  // click-to-change-action, because a pet that changes when you click it while
  // dragging it around gets annoying fast. Actions are picked from the menu.
  if (dragMoved <= CLICK_MOVE_TOLERANCE) {
    const now = Date.now();
    if (now - lastClickAt < DBLCLICK_MS) {
      lastClickAt = 0;
      size = PET_SIZE_PX;
      window.petHost.resize(size);
    } else {
      lastClickAt = now;
    }
  }
}

IMG.addEventListener("pointerup", endDrag);
IMG.addEventListener("pointercancel", endDrag);

IMG.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const next = Math.max(MIN_SIZE_PX, Math.min(MAX_SIZE_PX, size * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    if (Math.round(next) === Math.round(size)) return;
    size = next;
    window.petHost.resize(size);
  },
  { passive: false }
);

// The pet accepts the mouse across its whole square. Main overrides this while
// the 鼠标穿透 toggle is on.
setInteractive(true);

// Right-click opens the custom menu.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.petHost.contextMenu();
});

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------
function updateTrayIcon() {
  // Never overwrite a good icon with an undecoded (blank) frame.
  if (!IMG.complete || !IMG.naturalWidth) return;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const cx = c.getContext("2d");
    cx.drawImage(IMG, 0, 0, 32, 32);
    window.petHost.setTrayIcon(c.toDataURL("image/png"));
  } catch (_) {
    // Main keeps its current icon.
  }
}

// ---------------------------------------------------------------------------
// Commands from the menu, the tray and the picker
// ---------------------------------------------------------------------------
window.petHost.onExec((msg) => {
  if (!msg) return;
  switch (msg.cmd) {
    case "reaction":
      showReaction(msg.arg);
      break;
    case "click-through-off":
      // Forced pass-through was just disabled in main. Main resets its cached
      // value in the same breath, so re-asserting the square always lands.
      interactive = null;
      setInteractive(true);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  let started = false;
  for (let attempt = 0; attempt < 30 && !started; attempt++) {
    try {
      const cat = await window.petHost.catalog();
      if (cat.current) {
        // Resume whatever was on screen last time, so the pet looks the same
        // after a restart as it did before one.
        await showAnimation("reaction", cat.current);
        started = true;
      } else if (cat.skins && cat.skins.length) {
        // Nothing picked yet: fall back to the first skin frame.
        await showAnimation("skin", cat.skins[0], "idleA");
        started = true;
      }
    } catch (_) {
      // Folders not readable yet; retry below.
    }
    if (!started) await sleep(1000);
  }

  if (!started) {
    const note = document.createElement("div");
    note.id = "fallback";
    note.textContent = "找不到素材";
    note.title = "请确认程序旁边有「蓝色大肥鱼表情包」文件夹";
    document.body.append(note);
  }
}

boot();
