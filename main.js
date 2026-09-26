// 鲸鱼娘桌宠 — main process.
//
// A standalone Windows desktop pet. No DSH, no server, no Node required on the
// target machine: assets are read from folders next to the executable.
//
// The only network traffic is the optional DeepSeek balance check, which also
// polls on a timer once a key is saved — see BALANCE_POLL_MS — and 一言, which
// is on by default and fetches from a public quote service every few minutes.
// Nothing else leaves the machine, and 一言 can be switched off in the menu.
"use strict";

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  Notification,
  safeStorage,
  shell
} = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { isPeakNow, dateKey } = require("./peak");
const quotes = require("./quotes");

const DEFAULT_SKIN = "默认";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

// The author's page, opened from the tip window. It lives here rather than in
// the renderer so that nothing running in a window can talk the shell into
// opening an address of its choosing.
const AUTHOR_URL = "https://space.bilibili.com/177308205";

// The pose the pet settles into when nothing has been picked yet. It is a
// reaction, not a skin frame: this build has no idle pose, so the startup image
// is just another action — picking something else replaces it and it is
// remembered.
const DEFAULT_REACTION = "蓝色大肥鱼_工作(普通)_2026-08-18-14-39-12.gif";

// The very first thing the pet ever shows: it waves while the speech bubble
// says hello, then settles into DEFAULT_REACTION above. See startGreeting.
const GREETING_REACTION = "蓝色大肥鱼_打招呼 1_2026-08-18-14-14-29.gif";

// Role -> source filename. Each skin is five GIFs with these names.
const ROLE_FILE = { idleA: "1.gif", thinking: "2.gif", idleB: "3.gif", output: "4.gif", done: "5.gif" };

const PET_SIZE_PX = 220;
const MIN_SIZE_PX = 80;
const MAX_SIZE_PX = 640;
const EDGE_MARGIN = 16;

// How often the pet's always-on-top level is re-applied. Windows can drop a
// topmost window out of the topmost band without clearing WS_EX_TOPMOST, and
// leaves nothing to poll for, so the demotion has to be undone blind — see
// holdPetOnTop. Short enough that losing the race reads as a flicker rather
// than as the pet having gone missing.
const TOPMOST_REASSERT_MS = 3000;

// How often to sample the balance while the app runs, so "spent today" stays
// meaningful without the user having to click. Only used when a key is saved.
const BALANCE_POLL_MS = 10 * 60 * 1000;

// Speech bubble geometry. BUBBLE_PAD is the transparent margin bubble.css puts
// around the drawing so the glow is not clipped — main needs the same number to
// work out where inside the window the tail tip ended up.
const BUBBLE_PAD = 22;
const BUBBLE_GAP = 10; // space between the tail tip and the pet
// A / 一言 note is worth longer on screen than a status line: it is something
// to read rather than something to notice.
const BUBBLE_HIDE_MS = 8000;
const BUBBLE_READ_MS = 12000;

// 一言 — a quote from a public service every so often. On by default, which
// makes it the only part of the app that talks to a server that is not
// DeepSeek's, so the README and 使用说明 both say so plainly and the menu row
// switches it off. The interval is in minutes and clamped rather than trusted:
// it comes out of a text field the user can type into.
const HITOKOTO_DEFAULT_MINUTES = 5;
const HITOKOTO_MIN_MINUTES = 1;
const HITOKOTO_MAX_MINUTES = 24 * 60;

// The first-run greeting: the pet waves and the bubble says hello for ten
// seconds, then the pet settles into its ordinary pose. Clicking the bubble
// ends it early. Both the delay and the duration are here so the two halves of
// the greeting cannot drift apart.
const GREETING_DELAY_MS = 1500;
const GREETING_MS = 10000;
const GREETING_TEXT = "你好呀，我是鲸鱼娘～\n右键我可以看菜单。";

// The bubble styles the chooser offers, in the order it shows them. Each id is
// also the class suffix bubble.css defines (`.skin-<id>`), so the two lists have
// to stay in step; the label is only ever shown to the user.
const BUBBLE_STYLES = [
  { id: "classic", label: "经典蓝" },
  { id: "dark", label: "深色玻璃" },
  { id: "comic", label: "漫画白泡" },
  { id: "candy", label: "糖果泡" }
];
const BUBBLE_STYLE_DEFAULT = "classic";



// Keeps the config out of a Chinese-named directory: %APPDATA% is browsed by
// humans and by backup/cleanup tools, and ASCII survives both.
app.setPath("userData", path.join(app.getPath("appData"), "WhaleGirlPet"));

// Windows derives a notification's sender name from the App User Model ID. Left
// unset it falls back to the executable, which in development is electron.exe —
// so the first-run hint announced itself as "Electron". This must match the
// appId electron-builder is configured with.
const APP_ID = "com.xingkong.whalegirlpet";
app.setAppUserModelId(APP_ID);

// Taskbar and window titles read app.name, which otherwise comes from
// package.json's ASCII "name" field. Set explicitly so the name is right in
// development too, not only after packaging.
const APP_NAME = "鲸鱼娘桌宠";
app.setName(APP_NAME);

let win = null;
let menuWin = null;
let picker = null;
let settingsWin = null;
let tipWin = null;
let bubbleWin = null;
let stylesWin = null;
let hitokotoWin = null;
let tray = null;
let quitting = false;

let petSize = PET_SIZE_PX;
let interactive = false;
let hidden = false;
let trayIconFromFile = false;
// Timestamp of the last menu show, used to ignore a blur that is an artefact of
// the window appearing rather than the user clicking away.
let menuShownAt = 0;

// How long after showing the menu a blur is treated as noise. Windows may deny
// the foreground change outright — the pet's own window never activates the
// process — and that surfaces as an immediate blur.
const BLUR_GRACE_MS = 350;

// Speech bubble state. bubbleSay is what is on screen or on its way there;
// bubbleLayout is the measured rectangle, kept so the bubble can be moved again
// when the pet is dragged without having to measure it a second time.
let bubbleTimer = null;
let bubbleSay = null;
let bubbleLayout = null;

// True from launch until the first-run greeting is over. While it is set the
// pet waves instead of showing a remembered pose, so it has to outlive the
// config write that marks the first run as done.
let greetingPending = false;

// 一言's repeating timer — see scheduleHitokoto.
let hitokotoTimer = null;

let catalog = { skins: [], reactions: [] };
let currentSkin = null;

/** Everything the user can change, persisted as JSON in userData. */
let config = {
  clickThrough: false,
  firstRunDone: false,
  bubbleStyle: BUBBLE_STYLE_DEFAULT,
  hitokoto: true,
  hitokotoMinutes: HITOKOTO_DEFAULT_MINUTES,
  // Copied rather than referenced: this is a value the user can replace, and it
  // should not be possible to write through to the module's own constant.
  hitokotoCategories: [...quotes.DEFAULT_CATEGORIES]
};

/** True when a saved point still lands on a connected display. */
function isOnScreen(x, y) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    // A small tolerance so a pet parked flush against an edge still counts.
    return x >= a.x - 20 && y >= a.y - 20 && x < a.x + a.width && y < a.y + a.height;
  });
}

/**
 * Where the pet starts: wherever the user left it last time, if that spot is
 * still on a connected display. Unplugging a monitor would otherwise strand the
 * pet off-screen with no way to drag it back.
 */
function initialPetBounds(size) {
  const pos = config.petPos;
  if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) && isOnScreen(pos.x, pos.y)) {
    return { x: pos.x, y: pos.y, width: size, height: size };
  }
  return anchorBounds(size);
}

let saveBoundsTimer = null;
let pickerSaveTimer = null;

/** Persist the pet's geometry, coalescing the flood of events during a drag. */
function rememberPetBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    config.petPos = { x: b.x, y: b.y };
    config.petSize = b.width;
    saveConfig();
  }, 400);
}

// ---------------------------------------------------------------------------
// Paths
//
// In development the assets sit beside the source; once packaged they sit next
// to the executable, because they are shipped via extraFiles rather than baked
// into the asar. That is what lets a user drop their own GIFs into the folders.
// ---------------------------------------------------------------------------
function assetDir(name) {
  return app.isPackaged
    ? path.join(path.dirname(process.execPath), name)
    : path.join(__dirname, "assets", name);
}

function bundledAsset(name) {
  // Small assets that ARE packed into the asar.
  return path.join(__dirname, "assets", name);
}

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

// ---------------------------------------------------------------------------
// Config, including the DeepSeek API key
//
// The key is encrypted with Electron's safeStorage, which on Windows is DPAPI:
// the ciphertext is bound to the current Windows account, so copying the config
// file to another machine is useless. Users paste a real key that can spend
// real money, so plaintext on disk is not acceptable.
// ---------------------------------------------------------------------------
async function loadConfig() {
  try {
    const saved = JSON.parse(await fsp.readFile(configPath(), "utf8"));
    if (saved && typeof saved === "object") config = { ...config, ...saved };
  } catch (_) {
    // First run, or an unreadable file: defaults are fine.
  }
}

async function saveConfig() {
  try {
    await fsp.mkdir(path.dirname(configPath()), { recursive: true });
    await fsp.writeFile(configPath(), JSON.stringify(config, null, 2), "utf8");
  } catch (_) {
    // Losing a preference is not worth interrupting the user for.
  }
}

function setApiKey(key) {
  if (!key) {
    delete config.apiKeyEnc;
    delete config.apiKeyPlain;
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    config.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
    delete config.apiKeyPlain;
  } else {
    // Never silently pretend it is protected; the settings window says so.
    config.apiKeyPlain = key;
    delete config.apiKeyEnc;
  }
}

function getApiKey() {
  try {
    if (config.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(config.apiKeyEnc, "base64"));
    }
  } catch (_) {
    // A key saved under a different Windows account cannot be decrypted.
  }
  return config.apiKeyPlain || null;
}

function hasApiKey() {
  return Boolean(config.apiKeyEnc || config.apiKeyPlain);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Assets — local only. There is no host to fall back to.
// ---------------------------------------------------------------------------
async function readLocal(rootName, relPath) {
  const base = assetDir(rootName);
  if (typeof relPath !== "string" || relPath === "") return null;
  const full = path.resolve(base, relPath);
  // Refuse anything that escapes the asset root, however the name was crafted.
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  try {
    const bytes = new Uint8Array(await fsp.readFile(full));
    return bytes.length ? bytes : null;
  } catch (_) {
    return null;
  }
}

async function resolveAsset(kind, a, b) {
  if (kind === "skin") {
    const file = ROLE_FILE[b];
    if (!file) return null;
    return readLocal("素材", a === DEFAULT_SKIN ? file : `${a}/${file}`);
  }
  if (kind === "reaction") return readLocal("蓝色大肥鱼表情包", a);
  return null;
}

/** Skin names: the 素材 root plus every subdirectory holding the five GIFs. */
async function listSkins() {
  const names = [];
  try {
    const root = assetDir("素材");
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = await fsp.readdir(path.join(root, entry.name)).catch(() => []);
      if (inner.includes("1.gif")) names.push(entry.name);
    }
    const top = await fsp.readdir(root).catch(() => []);
    if (top.includes("1.gif")) names.unshift(DEFAULT_SKIN);
  } catch (_) {
    // Nothing usable; the renderer reports it.
  }
  return names;
}

async function listReactions() {
  try {
    const entries = await fsp.readdir(assetDir("蓝色大肥鱼表情包"));
    return entries.filter((f) => f.toLowerCase().endsWith(".gif")).sort();
  } catch (_) {
    return [];
  }
}

async function refreshCatalog() {
  catalog.skins = await listSkins();
  if (catalog.reactions.length === 0) catalog.reactions = await listReactions();
  if (!currentSkin || !catalog.skins.includes(currentSkin)) {
    currentSkin = catalog.skins[0] || null;
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// Pet window
// ---------------------------------------------------------------------------
function anchorBounds(size) {
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + workArea.width - size - EDGE_MARGIN);
  const y = Math.round(workArea.y + workArea.height - size - EDGE_MARGIN);
  // Clamp so a misreported work area can never push the pet off-screen.
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size)),
    width: size,
    height: size
  };
}

function createPetWindow() {
  win = new BrowserWindow({
    ...initialPetBounds(petSize),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // A pet must not steal focus from whatever you are typing in. On Windows
    // this maps to WS_EX_NOACTIVATE; the window still receives mouse input.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // "screen-saver" outranks ordinary always-on-top windows, so the pet stays
  // visible over maximised and most fullscreen apps.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Remember where the user parks it and how big they zoom it, so the next
  // launch resumes that instead of snapping back to the corner.
  win.on("moved", () => {
    rememberPetBounds();
    repositionBubble();
  });
  win.on("resized", () => {
    rememberPetBounds();
    repositionBubble();
  });
  win.on("closed", () => {
    win = null;
  });
}

/**
 * Apply the click-through preference.
 *
 * Off (default) is the alpha hit test: the renderer reports whether the cursor
 * is over an opaque pixel and the window follows. On forces pass-through
 * everywhere, for when the pet covers something you need to click.
 */
function applyClickThrough() {
  if (!win || win.isDestroyed()) return;
  interactive = false;
  win.setIgnoreMouseEvents(true, { forward: true });
  if (!config.clickThrough) send("click-through-off");
}

/**
 * Clamp a proposed pet rectangle so part of it always stays on a display.
 *
 * Without this the pet can be dragged fully past an edge — which is exactly
 * what happened while testing this, and leaves a window the user cannot grab
 * back without editing config.json by hand.
 */
function clampToDisplays(bounds) {
  const nearest = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  });
  const a = nearest.workArea;
  const keep = Math.min(80, bounds.width, bounds.height); // grabbable sliver
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, a.x - bounds.width + keep), a.x + a.width - keep),
    y: Math.min(Math.max(bounds.y, a.y - bounds.height + keep), a.y + a.height - keep)
  };
}

// ---------------------------------------------------------------------------
// Right-click menu — a custom window, not a native menu
//
// The pet's own menu is drawn in a frameless transparent window so it can match
// the pet's look. A native menu is styled by Windows and cannot be themed. The
// cost is that edge flipping, outside-click dismissal and Escape handling are
// ours to implement (see openMenu).
// ---------------------------------------------------------------------------
function menuItems() {
  const hasReactions = catalog.reactions.length > 0;
  return [
    { id: "click-through", label: "鼠标穿透", type: "check", checked: Boolean(config.clickThrough) },
    { type: "separator" },
    { id: "reaction-random", label: "随机表情", enabled: hasReactions },
    { id: "browse", label: `浏览全部表情（${catalog.reactions.length}）…`, enabled: hasReactions },
    { type: "separator" },
    { id: "balance", label: "查余额" },
    { id: "settings", label: "设置 API Key…" },
    { type: "separator" },
    { id: "auto-start", label: "开机自启", type: "check", checked: autoStartEnabled() },
    { id: "bubble-style", label: "气泡样式…" },
    { id: "hitokoto", label: "一言", type: "check", checked: config.hitokoto === true },
    { id: "hitokoto-interval", label: `一言间隔（${hitokotoMinutes()} 分钟）…` },
    { type: "separator" },
    { id: "tip", label: "请我喝杯奶茶" },
    { id: "quit", label: "退出" }
  ];
}

/**
 * Keep our own windows above the pet.
 *
 * The pet sits at "screen-saver" always-on-top level so it floats over other
 * apps, which means it also floats over the picker and hides the cells
 * underneath it — and a left-click on the pet plays a random action, so a click
 * aimed at a covered cell appears to change the action by itself.
 *
 * Two attempts at the alternative failed and are worth not repeating:
 *   - Lowering the pet's level drops it below EVERY window, so the user's
 *     browser ends up covering it.
 *   - Making the pet ignore mouse events while the picker is open works, but
 *     then the pet cannot be dragged or clicked at all, which is worse.
 *
 * So instead the utility windows join the same topmost band; the focused,
 * activatable picker then wins the z-order against the non-activatable pet.
 */
function bindAbovePet(auxWin) {
  const raise = () => {
    if (!auxWin || auxWin.isDestroyed()) return;
    auxWin.setAlwaysOnTop(true, "screen-saver");
    auxWin.moveTop();
  };
  auxWin.on("show", raise);
  auxWin.on("focus", raise);
}

/**
 * Re-apply the pet's always-on-top level, on a timer.
 *
 * Windows does not actually guarantee that a topmost window stays on top. A
 * window that gets maximised or brought to the foreground can push ours back
 * down into the ordinary z-order band, and from inside the app the demotion is
 * invisible: WS_EX_TOPMOST is left set, so isAlwaysOnTop() goes on answering
 * true and there is nothing to watch for. Electron has documented the same
 * thing since 2015 (electron/electron#2097) and the workaround everyone lands
 * on is to re-apply the level rather than set it once.
 *
 * The re-apply genuinely reaches the window: setAlwaysOnTop ends at
 * SetWindowPos(hwnd, HWND_TOPMOST, ...) with no early-out on the way down
 * (NativeWindowViews -> Widget -> DesktopWindowTreeHostWin ->
 * HWNDMessageHandler::SetAlwaysOnTop), so a repeat call is a real re-assert
 * and not a no-op.
 *
 * That call puts the pet at the top of the topmost band, which is also where
 * our own windows sit, so whatever is on screen gets raised again afterwards.
 * bindAbovePet does that on show/focus, which is too early to help here.
 */
function holdPetOnTop() {
  if (!win || win.isDestroyed() || hidden) return;
  win.setAlwaysOnTop(true, "screen-saver");
  for (const auxWin of [menuWin, picker, bubbleWin, stylesWin, hitokotoWin, settingsWin, tipWin]) {
    if (auxWin && !auxWin.isDestroyed() && auxWin.isVisible()) auxWin.moveTop();
  }
}

function createMenuWindow() {
  menuWin = new BrowserWindow({
    width: 200,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  menuWin.setAlwaysOnTop(true, "screen-saver");
  menuWin.loadFile(path.join(__dirname, "renderer", "menu.html"));

  // Losing focus is how an outside click dismisses the menu. That is also why
  // this window is focusable while the pet itself is not — but see menuShownAt:
  // a blur that lands in the same instant as the show is not a user action.
  menuWin.on("blur", () => {
    if (Date.now() - menuShownAt < BLUR_GRACE_MS) return;
    closeMenu();
  });
  menuWin.on("closed", () => {
    menuWin = null;
  });
}

function openMenu() {
  if (!menuWin || menuWin.isDestroyed()) createMenuWindow();
  // Show only after the renderer has laid out and reported its size, otherwise
  // the menu visibly jumps from the provisional size to the real one.
  menuWin.webContents.send("menu:items", menuItems());
}

function closeMenu() {
  if (menuWin && !menuWin.isDestroyed() && menuWin.isVisible()) menuWin.hide();
}

/** Size and place the menu at the cursor, flipping near a screen edge. */
function placeMenu(width, height) {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  let x = point.x;
  let y = point.y;
  if (x + width > workArea.x + workArea.width) x = point.x - width;
  if (y + height > workArea.y + workArea.height) y = point.y - height;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
  menuWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  // Stamp before showing: the blur guard measures from here, so a blur that
  // arrives as the window appears is not mistaken for a click elsewhere.
  menuShownAt = Date.now();
  menuWin.show();
  menuWin.focus();
}

function runMenuCommand(id) {
  closeMenu();
  switch (id) {
    case "click-through":
      config.clickThrough = !config.clickThrough;
      saveConfig();
      applyClickThrough();
      refreshTray();
      break;
    case "auto-start":
      setAutoStart(!autoStartEnabled());
      break;
    case "reaction-random":
      pickRandomReaction();
      break;
    case "browse":
      openPicker();
      break;
    case "bubble-style":
      openStyles();
      break;
    case "hitokoto":
      setHitokoto(config.hitokoto !== true);
      break;
    case "hitokoto-interval":
      openHitokoto();
      break;
    case "balance":
      // No key yet? Take the user somewhere they can fix that, rather than
      // showing a failure they cannot act on.
      if (hasApiKey()) showBalance();
      else openSettings(true);
      break;
    case "settings":
      openSettings(false);
      break;
    case "tip":
      openTip();
      break;
    case "quit":
      quitting = true;
      app.quit();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Speech bubble
//
// A third transparent always-on-top window, after the pet and the menu, on the
// same terms as the menu: the renderer draws it and reports how big the drawing
// came out, and main decides where it goes. Two things differ, both because of
// what a bubble is.
//
// It is anchored to the pet rather than to the cursor, so it is placed from the
// pet's bounds and moved again whenever the pet moves. And it must never take
// focus — the one promise this pet makes is that it does not pull the caret out
// of whatever you are typing in, and a greeting that did exactly that on
// startup would break the promise at the worst possible moment. So the window
// is created non-activatable, which also means there is no blur to dismiss it:
// it leaves on its own timer, or when it is clicked.
// ---------------------------------------------------------------------------

/**
 * How much bigger than the 220px default the bubble should be drawn.
 *
 * The pet zooms from 80px to 640px, and a bubble frozen at 13px looks like a
 * thumbtack next to the 640px case. Scaling is clamped at both ends: text has a
 * size below which it is simply hard to read, and past a point a bigger bubble
 * just covers more of the screen for no gain.
 */
function bubbleScale() {
  return Math.max(0.85, Math.min(1.3, petSize / PET_SIZE_PX));
}

/**
 * The chosen style, or the default if config holds an id this build does not
 * know — which is what an older config file, or one edited by hand, would give.
 */
function bubbleStyle() {
  return BUBBLE_STYLES.some((s) => s.id === config.bubbleStyle)
    ? config.bubbleStyle
    : BUBBLE_STYLE_DEFAULT;
}

/** Whether the pet is on screen, and so whether it can do the talking itself. */
function petCanSpeak() {
  return Boolean(win) && !win.isDestroyed() && !hidden;
}

/** Is there room for a bubble of this size on the given side of the pet? */
function bubbleFits(placement, height) {
  if (!win || win.isDestroyed()) return false;
  const p = win.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({
    x: p.x + Math.round(p.width / 2),
    y: p.y + Math.round(p.height / 2)
  });
  // How far the drawing reaches out from the tail tip. Everything past that is
  // the transparent margin bubble.css keeps around it for the glow.
  const reach = height - BUBBLE_PAD;
  return placement === "above"
    ? p.y - BUBBLE_GAP - reach >= workArea.y
    : p.y + p.height + BUBBLE_GAP + reach <= workArea.y + workArea.height;
}

/** Put the window so the tail tip lands BUBBLE_GAP away from the pet. */
function placeBubble(width, height, placement) {
  const p = win.getBounds();
  const cx = p.x + Math.round(p.width / 2);
  const cy = p.y + Math.round(p.height / 2);
  const { workArea } = screen.getDisplayNearestPoint({ x: cx, y: cy });

  // The tail tip sits BUBBLE_PAD in from whichever window edge faces the pet;
  // the rest of the padding is the slack the glow lives in.
  let x = cx - Math.round(width / 2);
  let y =
    placement === "above"
      ? p.y - BUBBLE_GAP - (height - BUBBLE_PAD)
      : p.y + p.height + BUBBLE_GAP - BUBBLE_PAD;

  x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - width - 4));
  y = Math.max(workArea.y + 4, Math.min(y, workArea.y + workArea.height - height - 4));
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

/** Keep the bubble beside the pet after the pet has been dragged or zoomed. */
function repositionBubble() {
  if (!bubbleLayout || !bubbleWin || bubbleWin.isDestroyed() || !bubbleWin.isVisible()) return;
  if (!win || win.isDestroyed()) return;
  placeBubble(bubbleLayout.width, bubbleLayout.height, bubbleLayout.placement);
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubbleLayout = null;
  const after = bubbleSay ? bubbleSay.onHide : null;
  bubbleSay = null;
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide();
  // Runs last, so whatever it changes happens with the bubble already gone.
  if (after) after();
}

function createBubbleWindow() {
  bubbleWin = new BrowserWindow({
    // Provisional; replaced by the measured size before it is ever shown.
    width: 280,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Non-activatable, exactly like the pet. It still receives the click that
    // dismisses it — focusable: false only affects activation, not input, which
    // is how the pet can be dragged without ever being focused.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWin.loadFile(path.join(__dirname, "renderer", "bubble.html"));
  bubbleWin.on("closed", () => {
    bubbleWin = null;
  });
}

/** Hand the current text to the renderer, which answers with a measured size. */
function pushBubbleText() {
  if (!bubbleSay || !bubbleWin || bubbleWin.isDestroyed()) return;
  bubbleWin.webContents.send("bubble:show", {
    text: bubbleSay.text,
    skin: bubbleSay.skin,
    scale: bubbleSay.scale,
    placement: bubbleSay.placement
  });
}

/**
 * Say something next to the pet. `onHide` runs once the bubble is gone,
 * whichever way it went.
 *
 * How big a bubble is depends on the text and the scale, so it cannot be placed
 * until it has been drawn once: this hands the text over and waits for the
 * renderer to report back. bubbleMeasured does the rest.
 */
function showBubble(text, ms, onHide) {
  if (!win || win.isDestroyed()) return;
  if (typeof text !== "string" || !text.trim()) return;

  // A bubble replaced before it finished still owes its onHide. The first-run
  // greeting is the case that matters: it uses onHide to settle the pet out of
  // the wave, and dropping it because the user asked for a balance mid-greeting
  // would leave the pet waving for good.
  if (bubbleSay && bubbleSay.onHide) bubbleSay.onHide();

  const p = win.getBounds();
  const { workArea } = screen.getDisplayNearestPoint({
    x: p.x + Math.round(p.width / 2),
    y: p.y + Math.round(p.height / 2)
  });
  // Start on the roomier side, so the bubble rarely has to be flipped after
  // measuring — a flip is a second round trip and a visible relayout.
  const roomAbove = p.y - workArea.y;
  const roomBelow = workArea.y + workArea.height - (p.y + p.height);

  bubbleSay = {
    text,
    // Read at show time rather than when the window was created, so a style
    // picked in the chooser applies to the very next thing the pet says.
    skin: bubbleStyle(),
    scale: bubbleScale(),
    placement: roomBelow > roomAbove ? "below" : "above",
    ms: ms || BUBBLE_HIDE_MS,
    onHide: onHide || null
  };

  if (!bubbleWin || bubbleWin.isDestroyed()) {
    // The renderer asks for the text once it has loaded — see bubble:ready.
    createBubbleWindow();
    return;
  }
  pushBubbleText();
}

function bubbleMeasured(size) {
  if (!bubbleSay || !bubbleWin || bubbleWin.isDestroyed() || !size) return;
  const width = Math.max(80, Math.ceil(size.width));
  const height = Math.max(40, Math.ceil(size.height));

  // The side chosen from the raw room may still be too short for a tall bubble.
  // If the other side takes it, redraw with the tail flipped — but only ever
  // once, so a bubble that fits nowhere settles for being clamped instead of
  // bouncing between the two.
  if (!bubbleFits(bubbleSay.placement, height) && !bubbleSay.flipped) {
    const other = bubbleSay.placement === "above" ? "below" : "above";
    if (bubbleFits(other, height)) {
      bubbleSay = { ...bubbleSay, placement: other, flipped: true };
      pushBubbleText();
      return;
    }
  }

  const { placement, ms } = bubbleSay;
  bubbleLayout = { width, height, placement };
  placeBubble(width, height, placement);
  bubbleWin.showInactive();
  // The entrance starts only now, so it is never spent while the window is
  // still hidden.
  bubbleWin.webContents.send("bubble:pop");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, ms);
}

/**
 * First launch: wave, say hello, then settle down.
 *
 * The waving and the bubble are one gesture, so they start and end together —
 * endGreeting is driven by the bubble's own timer or by a click on it, never by
 * a second timer that could drift out of step with the first.
 */
function startGreeting() {
  greetingPending = true;
  setTimeout(() => {
    if (!greetingPending) return;
    showBubble(GREETING_TEXT, GREETING_MS, endGreeting);
  }, GREETING_DELAY_MS);
}

function endGreeting() {
  if (!greetingPending) return;
  greetingPending = false;
  // Settle into the ordinary pose, and remember it: the greeting is a one-time
  // thing, so the next launch should start where this one left off. If the GIF
  // is missing the catalog's first entry stands in.
  const next = catalog.reactions.includes(DEFAULT_REACTION) ? DEFAULT_REACTION : catalog.reactions[0];
  if (next) pickReaction(next);
}

// ---------------------------------------------------------------------------
// Bubble style chooser
//
// Five options is more than a menu wants, and their names say nothing on their
// own — nobody can choose between 「糖果泡」and 「深色玻璃」 from the words. So the
// choice is made by looking, in a window that draws one real bubble per style
// out of the same stylesheet the bubble itself uses.
// ---------------------------------------------------------------------------
function openStyles() {
  if (stylesWin && !stylesWin.isDestroyed()) {
    stylesWin.show();
    stylesWin.moveTop();
    stylesWin.focus();
    return;
  }
  stylesWin = new BrowserWindow({
    width: 800,
    height: 720,
    // Resizable, unlike the other utility windows: this one is a reflowing grid
    // and how much of it wants to be on screen at once depends on the display.
    minWidth: 520,
    minHeight: 420,
    maximizable: false,
    title: "鲸鱼娘桌宠 · 气泡样式",
    icon: bundledAsset("icon.ico"),
    backgroundColor: "#16232d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  stylesWin.setMenuBarVisibility(false);
  stylesWin.loadFile(path.join(__dirname, "renderer", "bubble-styles.html"));
  bindAbovePet(stylesWin);
  stylesWin.on("closed", () => {
    stylesWin = null;
  });
}

// ---------------------------------------------------------------------------
// 一言
//
// A quote from a public service, on a timer, said through the same bubble as
// everything else. Off until it is switched on: it is the only thing in the app
// that talks to a server the user did not ask it to talk to, and once on it
// keeps talking for as long as the app runs.
// ---------------------------------------------------------------------------

/** The configured interval, clamped. Comes out of a text field, so not trusted. */
function clampHitokotoMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return HITOKOTO_DEFAULT_MINUTES;
  return Math.max(HITOKOTO_MIN_MINUTES, Math.min(HITOKOTO_MAX_MINUTES, Math.round(n)));
}

function hitokotoMinutes() {
  return clampHitokotoMinutes(config.hitokotoMinutes);
}

/**
 * The sentence types to ask for.
 *
 * A list that is missing or the wrong shape is a broken config and falls back
 * to the default set. An empty list is not broken — it is what unchecking
 * everything gives, and it means 不限.
 */
function hitokotoCategories() {
  if (!Array.isArray(config.hitokotoCategories)) return quotes.DEFAULT_CATEGORIES;
  return quotes.normaliseCategories(config.hitokotoCategories);
}

/** Point the timer at the current setting. Safe to call at any time. */
function scheduleHitokoto() {
  clearTimeout(hitokotoTimer);
  hitokotoTimer = null;
  if (config.hitokoto !== true) return;
  hitokotoTimer = setTimeout(sayHitokoto, hitokotoMinutes() * 60 * 1000);
}

async function sayHitokoto() {
  // Re-armed before the request rather than after it, so a slow endpoint — or
  // one that never answers — cannot stall the series.
  scheduleHitokoto();
  if (!petCanSpeak()) return;
  const quote = await quotes.fetchOne(hitokotoCategories());
  if (!quote) return;
  // It may have been switched off, or the pet hidden, while that was in flight.
  if (config.hitokoto !== true || !petCanSpeak()) return;
  showBubble(quotes.render(quote), BUBBLE_READ_MS);
}

function setHitokoto(on) {
  config.hitokoto = on === true;
  saveConfig();
  scheduleHitokoto();
  refreshTray();
  // Say one straight away on the way on: otherwise the switch looks like it did
  // nothing for the next five minutes, and there is no way to tell whether it
  // worked short of waiting to find out.
  if (config.hitokoto) sayHitokoto();
}

/**
 * 每到整点查一次余额，并说出来。
 *
 * The ten-minute poll only maintains the running total and never speaks. This
 * is the one that reports: on the hour, so the number turns up at a predictable
 * moment instead of at whatever offset from launch the app happened to start
 * at. A hidden pet has no bubble to say it with, so that case falls back to
 * updating the tally in silence — an hourly notification would be worse than
 * saying nothing.
 */
function scheduleHourlyBalance() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  setTimeout(() => {
    if (hasApiKey()) showBalance({ silent: !petCanSpeak() });
    scheduleHourlyBalance();
  }, next - now);
}

// ---------------------------------------------------------------------------
// 一言 interval
// ---------------------------------------------------------------------------
/**
 * Everything the settings window needs, in one shape.
 *
 * `available` travels with the state rather than being hard-coded in the
 * renderer so the two lists cannot drift: an id the window offers but this
 * build does not know about would be filtered out of the request and the user
 * would be left wondering why their choice did nothing.
 */
function hitokotoStatePayload() {
  return {
    minutes: hitokotoMinutes(),
    on: config.hitokoto === true,
    categories: hitokotoCategories(),
    available: quotes.CATEGORIES
  };
}

function pushHitokotoState() {
  if (!hitokotoWin || hitokotoWin.isDestroyed()) return;
  hitokotoWin.webContents.send("hitokoto:state", hitokotoStatePayload());
}

function openHitokoto() {
  if (hitokotoWin && !hitokotoWin.isDestroyed()) {
    hitokotoWin.show();
    hitokotoWin.moveTop();
    hitokotoWin.focus();
    return;
  }
  hitokotoWin = new BrowserWindow({
    width: 620,
    height: 610,
    resizable: false,
    maximizable: false,
    title: "鲸鱼娘桌宠 · 一言",
    icon: bundledAsset("icon.ico"),
    backgroundColor: "#16232d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  hitokotoWin.setMenuBarVisibility(false);
  hitokotoWin.loadFile(path.join(__dirname, "renderer", "hitokoto.html"));
  bindAbovePet(hitokotoWin);
  hitokotoWin.on("closed", () => {
    hitokotoWin = null;
  });
}

// ---------------------------------------------------------------------------
// Action picker
// ---------------------------------------------------------------------------
function openPicker() {
  if (picker && !picker.isDestroyed()) {
    picker.show();
    picker.moveTop();
    picker.focus();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const saved = config.pickerBounds;
  const width = Math.min(saved && saved.width ? saved.width : 1200, workArea.width);
  const height = Math.min(saved && saved.height ? saved.height : 880, workArea.height);
  const position =
    saved && Number.isInteger(saved.x) && Number.isInteger(saved.y) ? { x: saved.x, y: saved.y } : {};

  picker = new BrowserWindow({
    width,
    height,
    ...position,
    minWidth: 420,
    minHeight: 320,
    title: "鲸鱼娘桌宠 · 表情",
    icon: bundledAsset("icon.ico"),
    backgroundColor: "#16232d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  picker.setMenuBarVisibility(false);
  picker.loadFile(path.join(__dirname, "renderer", "picker.html"));
  bindAbovePet(picker);

  // Remember the picker's spot as it moves, not only on close: a crash or a
  // force-quit would otherwise lose it, and reopening at the default size in
  // the middle of the screen is exactly what the user asked to avoid.
  const remember = () => {
    clearTimeout(pickerSaveTimer);
    pickerSaveTimer = setTimeout(() => {
      if (!picker || picker.isDestroyed() || picker.isMinimized()) return;
      config.pickerBounds = picker.getBounds();
      saveConfig();
    }, 400);
  };
  const rememberNow = () => {
    clearTimeout(pickerSaveTimer);
    if (!picker || picker.isDestroyed() || picker.isMinimized()) return;
    config.pickerBounds = picker.getBounds();
    saveConfig();
  };
  picker.on("moved", remember);
  picker.on("resized", remember);
  picker.on("close", rememberNow);
  picker.on("closed", () => {
    picker = null;
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings(focusKeyField) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (focusKeyField) settingsWin.webContents.send("settings:focus-key");
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 360,
    resizable: false,
    maximizable: false,
    title: "鲸鱼娘桌宠 · 设置",
    icon: bundledAsset("icon.ico"),
    backgroundColor: "#16232d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  bindAbovePet(settingsWin);
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

/**
 * Fold a fresh balance reading into today's spend total.
 *
 * The API only ever reports the *current* balance — there is no usage or
 * billing endpoint (every plausible path 404s), so "spent today" has to be
 * accumulated here. Each observed decrease is added; top-ups are skipped rather
 * than counted as negative spending. Money spent and then topped up again
 * entirely between two readings is invisible, which is why this is a tally of
 * what was observed rather than an official statement.
 */
function trackSpend(balance) {
  const today = dateKey(new Date());
  const prev = config.spend && typeof config.spend === "object" ? config.spend : {};

  if (prev.day !== today) {
    // First reading of a new day: it becomes the baseline, spending resets.
    config.spend = { day: today, total: 0, lastBalance: balance };
    saveConfig();
    return config.spend;
  }

  const last = Number(prev.lastBalance);
  let total = Number(prev.total) || 0;
  if (Number.isFinite(last) && balance < last) {
    total = Number((total + (last - balance)).toFixed(2));
  }
  config.spend = { day: today, total, lastBalance: balance };
  saveConfig();
  return config.spend;
}

/**
 * The tip window.
 *
 * A plain framed window rather than another frameless one: it is something you
 * look at once and close, and a title bar is the clearest way to offer that.
 */
function openTip() {
  if (tipWin && !tipWin.isDestroyed()) {
    tipWin.show();
    tipWin.moveTop();
    tipWin.focus();
    return;
  }
  tipWin = new BrowserWindow({
    width: 380,
    height: 540,
    resizable: false,
    maximizable: false,
    title: "请我喝杯奶茶",
    icon: bundledAsset("icon.ico"),
    backgroundColor: "#16232d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  tipWin.setMenuBarVisibility(false);
  tipWin.loadFile(path.join(__dirname, "renderer", "tip.html"));
  bindAbovePet(tipWin);
  tipWin.on("closed", () => {
    tipWin = null;
  });
}

/** ¥ rather than CNY — this is a desktop pet, not a bank statement. */
const CURRENCY_SIGN = { CNY: "¥", RMB: "¥", USD: "$", EUR: "€", JPY: "¥", GBP: "£" };

function money(amount, currency) {
  const value = Number(amount).toFixed(2);
  const sign = CURRENCY_SIGN[String(currency || "").trim().toUpperCase()];
  // An unrecognised currency keeps its code: a wrong symbol is worse than a
  // code nobody has to guess at.
  return sign ? `${sign}${value}` : `${value} ${currency || ""}`.trim();
}

async function showBalance({ silent = false } = {}) {
  const key = getApiKey();
  if (!key) {
    // Only bother the user about the missing key when they asked for a balance.
    if (!silent) openSettings(true);
    return;
  }
  try {
    const res = await fetch(DEEPSEEK_BALANCE_URL, { headers: { authorization: "Bearer " + key } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? "：" + text.slice(0, 200) : ""}`);
    const info = JSON.parse(text)?.balance_infos?.[0];
    if (!info) throw new Error("余额接口没有返回数据");

    const balance = Number(info.total_balance);
    const spend = trackSpend(balance);
    if (silent) return;
    const period = isPeakNow() ? "现在是高峰时段" : "现在是空闲时段（半价）";
    const left = money(balance, info.currency);
    const today = money(spend.total, info.currency);
    // The pet says it instead of Windows announcing it. A notification for
    // something the pet is already sitting there ready to be asked looked like
    // a different program interrupting — and the pet's own bubble can be drawn
    // in the app's colours. The notification survives only for a hidden pet,
    // which has no bubble to speak from.
    if (petCanSpeak()) {
      showBubble(`余额 ${left}\n今日消费 ${today}\n${period}`);
    } else {
      notify("鲸鱼娘桌宠 · 余额", `余额 ${left} · 今日消费 ${today} · ${period}`);
    }
  } catch (err) {
    if (silent) return;
    const message = err && err.message ? err.message : String(err);
    if (petCanSpeak()) {
      // The error carries up to 200 characters of response body. A bubble is
      // not the place for a wall of JSON, so it is cut to something readable.
      showBubble(`余额查询失败\n${message.slice(0, 90)}`);
    } else {
      notify("鲸鱼娘桌宠 · 余额查询失败", message);
    }
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
      return;
    }
  } catch (_) {
    // Fall through to the tray balloon so the value is never simply lost.
  }
  if (tray) tray.displayBalloon({ title, content: body });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function trayIconImage() {
  try {
    const img = nativeImage.createFromPath(bundledAsset("tray.png"));
    if (!img.isEmpty()) {
      trayIconFromFile = true;
      // Tray slots are 16px at 100% scaling and 32px at 200%; 32 covers both.
      return img.resize({ width: 32, height: 32, quality: "best" });
    }
  } catch (_) {
    // Fall through to whatever the renderer sends.
  }
  trayIconFromFile = false;
  return nativeImage.createEmpty();
}

/**
 * The tray keeps a native menu. Windows owns the styling of that menu, so it
 * cannot match the pet's custom one; that inconsistency is accepted in exchange
 * for the tray remaining a dependable way back to the app when the pet is
 * hidden or click-through is on.
 */
function buildTrayMenu() {
  const hasReactions = catalog.reactions.length > 0;
  const items = [
    { label: "鼠标穿透", type: "checkbox", checked: Boolean(config.clickThrough), click: () => runMenuCommand("click-through") },
    { label: "随机表情", enabled: hasReactions, click: () => pickRandomReaction() },
    { label: "浏览全部表情…", enabled: hasReactions, click: () => openPicker() },
    { type: "separator" },
    { label: "查余额", click: () => runMenuCommand("balance") },
    { label: "设置 API Key…", click: () => openSettings(false) },
    { type: "separator" },
    { label: "开机自启", type: "checkbox", checked: autoStartEnabled(), click: () => runMenuCommand("auto-start") },
    { label: "气泡样式…", click: () => openStyles() },
    { label: "一言", type: "checkbox", checked: config.hitokoto === true, click: () => runMenuCommand("hitokoto") },
    { label: `一言间隔（${hitokotoMinutes()} 分钟）…`, click: () => openHitokoto() },
    { type: "separator" },
    { label: "请我喝杯奶茶", click: () => openTip() },
    { label: "退出", click: () => { quitting = true; app.quit(); } }
  ];
  return Menu.buildFromTemplate(items);
}

// ---------------------------------------------------------------------------
// Auto-start
//
// Windows stores this in HKCU\...\Run, so the OS is the source of truth and no
// copy is kept in config.json.
// ---------------------------------------------------------------------------
/**
 * Options for the login-item APIs.
 *
 * Windows matches the Run entry on executable AND arguments, so reading must
 * pass the same pair that writing did. Without this a development-mode entry
 * (electron.exe plus the project path) never matches, getLoginItemSettings
 * reports "off", and toggling the switch writes the entry again instead of
 * removing it — the switch appears to do nothing when turned off.
 */
function loginItemOptions(openAtLogin) {
  const options = { openAtLogin };
  if (!app.isPackaged) {
    // Development runs electron.exe, which on its own would boot a blank
    // Electron rather than this pet; it needs the project directory.
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }
  return options;
}

function autoStartEnabled() {
  try {
    return app.getLoginItemSettings(loginItemOptions(false)).openAtLogin;
  } catch (_) {
    return false;
  }
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings(loginItemOptions(enabled));
  } catch (_) {
    // Registry access can fail under policy; nothing useful to do about it.
  }
  refreshTray();
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function toggleHidden() {
  if (!win || win.isDestroyed()) return;
  hidden = !hidden;
  if (hidden) {
    win.hide();
    // A bubble floating beside a pet that is no longer there makes no sense.
    hideBubble();
  } else {
    win.showInactive();
  }
  refreshTray();
}

function send(cmd, arg) {
  if (win && !win.isDestroyed()) win.webContents.send("pet:exec", { cmd, arg });
}

/**
 * Show one action and remember it.
 *
 * The pet has no idle pose: whatever is picked stays on screen until something
 * else is picked, including across a restart. Deciding the name here rather
 * than in the renderer means random picks get remembered too.
 */
function pickReaction(name) {
  if (typeof name !== "string" || !name) return;
  config.lastReaction = name;
  saveConfig();
  send("reaction", name);
}

function pickRandomReaction() {
  if (catalog.reactions.length === 0) return;
  pickReaction(catalog.reactions[Math.floor(Math.random() * catalog.reactions.length)]);
}

/** Resize keeping the bottom-right corner pinned, so the pet grows up-left. */
function applySize(next) {
  if (!win || win.isDestroyed()) return;
  const size = Math.max(MIN_SIZE_PX, Math.min(MAX_SIZE_PX, Math.round(next)));
  if (size === petSize) return;
  const old = win.getBounds();
  petSize = size;
  win.setBounds({
    x: old.x + (old.width - size),
    y: old.y + (old.height - size),
    width: size,
    height: size
  });
  rememberPetBounds();
  // The bubble keeps the size it was measured at rather than being re-measured
  // for the new scale: the two would only differ partway through a zoom, and a
  // bubble that is up for a few seconds is not worth a second layout round
  // trip. It still follows the pet, which is the part that would look broken.
  repositionBubble();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle("pet:catalog", async () => {
    await refreshCatalog();
    // `current` is what the pet should show on launch: the last action picked,
    // falling back to the built-in default when nothing has been picked yet —
    // or to the wave, while the first-run greeting is still on screen.
    const remembered = config.lastReaction;
    let current = null;
    if (greetingPending && catalog.reactions.includes(GREETING_REACTION)) current = GREETING_REACTION;
    else if (remembered && catalog.reactions.includes(remembered)) current = remembered;
    else if (catalog.reactions.includes(DEFAULT_REACTION)) current = DEFAULT_REACTION;
    else current = catalog.reactions[0] || null;
    return { ...catalog, currentSkin, petSize, current };
  });

  ipcMain.handle("pet:asset", (_e, kind, a, b) => resolveAsset(kind, a, b));

  ipcMain.handle("settings:state", () => ({
    hasKey: hasApiKey(),
    encrypted: Boolean(config.apiKeyEnc),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    configPath: configPath()
  }));

  ipcMain.handle("settings:save-key", async (_e, key) => {
    const trimmed = typeof key === "string" ? key.trim() : "";
    setApiKey(trimmed || null);
    await saveConfig();
    return { hasKey: hasApiKey(), encrypted: Boolean(config.apiKeyEnc) };
  });

  ipcMain.handle("settings:clear-key", async () => {
    setApiKey(null);
    await saveConfig();
    return { hasKey: false, encrypted: false };
  });

  ipcMain.on("pet:interactive", (_e, want) => {
    // Forced pass-through wins over the renderer's own hit reporting.
    if (config.clickThrough) return;
    const next = !!want;
    if (next === interactive) return;
    interactive = next;
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!next, { forward: true });
  });

  ipcMain.on("pet:drag", (_e, delta) => {
    if (!win || win.isDestroyed() || !delta) return;
    const b = win.getBounds();
    win.setBounds(
      clampToDisplays({
        x: Math.round(b.x + (delta.dx || 0)),
        y: Math.round(b.y + (delta.dy || 0)),
        width: b.width,
        height: b.height
      })
    );
    // Windows does not emit "moved" for a programmatic setBounds, so the drag
    // handler is what has to remember the position — and move the bubble, which
    // is anchored to the pet and would otherwise be left behind mid-drag.
    rememberPetBounds();
    repositionBubble();
  });

  ipcMain.on("pet:resize", (_e, size) => applySize(size));

  ipcMain.on("pet:context-menu", () => openMenu());

  ipcMain.on("pet:menu-ready", () => {
    if (menuWin && !menuWin.isDestroyed()) menuWin.webContents.send("menu:items", menuItems());
  });

  ipcMain.on("pet:menu-size", (_e, size) => {
    if (!menuWin || menuWin.isDestroyed() || !size) return;
    const width = Math.max(120, Math.ceil(size.width));
    const height = Math.max(40, Math.ceil(size.height));
    placeMenu(width, height);
  });

  ipcMain.on("pet:menu-command", (_e, id) => runMenuCommand(id));

  ipcMain.on("pet:menu-close", () => closeMenu());

  ipcMain.on("pet:open-picker", () => openPicker());

  ipcMain.on("pet:picker-close", () => {
    if (picker && !picker.isDestroyed()) picker.close();
  });

  // Picking an action plays it but leaves the picker open, so a user can try
  // several in a row without reopening the window each time.
  // Picking an action shows it and leaves the picker open, so a user can try
  // several in a row without reopening the window each time.
  ipcMain.on("pet:play-reaction", (_e, name) => pickReaction(name));

  // The pet's own left-click asks for a random one, so the choice is remembered
  // in the same place as an explicit pick.
  ipcMain.on("pet:random-reaction", () => pickRandomReaction());

  ipcMain.on("pet:tray-icon", (_e, dataUrl) => {
    if (trayIconFromFile || !tray) return;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) return;
    try {
      const img = nativeImage.createFromDataURL(dataUrl);
      if (!img.isEmpty()) tray.setImage(img);
    } catch (_) {
      // Keep the current icon; a bad thumbnail is not worth failing over.
    }
  });

  ipcMain.on("bubble:ready", () => pushBubbleText());

  ipcMain.on("bubble:size", (_e, size) => bubbleMeasured(size));

  // A click dismisses it. During the first-run greeting that also ends the wave,
  // because hideBubble runs whatever onHide the greeting registered.
  ipcMain.on("bubble:click", () => hideBubble());

  ipcMain.handle("bubble:styles", () => ({ current: bubbleStyle(), styles: BUBBLE_STYLES }));

  ipcMain.on("bubble:set-style", (_e, id) => {
    // The id arrives from a renderer, so it is checked rather than trusted: it
    // becomes a class name in bubble.js and a value in config.json.
    if (!BUBBLE_STYLES.some((s) => s.id === id)) return;
    config.bubbleStyle = id;
    saveConfig();
    // Say something in the new style straight away. The chooser can show the
    // shape, but the reason to pick one is how it looks beside the pet, at the
    // size the pet will really use it.
    showBubble("换成这个样式啦～");
  });

  ipcMain.on("bubble:close-styles", () => {
    if (stylesWin && !stylesWin.isDestroyed()) stylesWin.close();
  });

  ipcMain.handle("hitokoto:state", () => hitokotoStatePayload());

  ipcMain.on("hitokoto:set-categories", (_e, ids) => {
    // Normalised here rather than trusted: this becomes the `c` parameter sent
    // to a third party, and it comes from a renderer.
    config.hitokotoCategories = quotes.normaliseCategories(ids);
    saveConfig();
    // No need to re-arm the timer. The list is read when the request is made,
    // so the next tick already uses the new one, and re-arming would push the
    // next sentence away every time a checkbox is clicked.
    pushHitokotoState();
  });

  ipcMain.on("hitokoto:set-minutes", (_e, minutes) => {
    config.hitokotoMinutes = clampHitokotoMinutes(minutes);
    saveConfig();
    // Re-armed rather than left running: a new interval that only took effect
    // after the old one fired would look like it had been ignored.
    scheduleHitokoto();
    refreshTray();
    pushHitokotoState();
  });

  ipcMain.on("hitokoto:preview", () => sayHitokoto());

  ipcMain.on("hitokoto:close", () => {
    if (hitokotoWin && !hitokotoWin.isDestroyed()) hitokotoWin.close();
  });

  // The QR image lives inside the asar, so it is handed over as bytes and shown
  // through a blob: URL like every other image in the app.
  ipcMain.handle("tip:image", async () => {
    try {
      return new Uint8Array(await fsp.readFile(bundledAsset("zanshang.png")));
    } catch (_) {
      return null;
    }
  });

  ipcMain.on("tip:fit", (_e, height) => {
    if (!tipWin || tipWin.isDestroyed()) return;
    const next = Math.max(200, Math.ceil(Number(height) || 0));
    const bounds = tipWin.getBounds();
    if (Math.abs(bounds.height - next) < 2) return;
    tipWin.setBounds({ ...bounds, height: next });
  });

  ipcMain.on("tip:close", () => {
    if (tipWin && !tipWin.isDestroyed()) tipWin.close();
  });

  ipcMain.on("tip:open-author", () => {
    // A failure here is a missing browser or a blocked URL, neither of which is
    // worth interrupting someone who was only trying to look at a homepage.
    shell.openExternal(AUTHOR_URL).catch(() => {});
  });

  ipcMain.on("settings:close", () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });

  // The settings window is sized to its content, so nothing can clip or grow a
  // scrollbar when the status text or the config path changes length.
  ipcMain.on("settings:fit", (_e, height) => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    const next = Math.max(160, Math.ceil(Number(height) || 0));
    const bounds = settingsWin.getBounds();
    if (Math.abs(bounds.height - next) < 2) return;
    settingsWin.setBounds({ ...bounds, height: next });
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  console.error("[pet] 已有实例在运行（单实例锁被占用），本次启动退出");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      hidden = false;
      win.showInactive();
      refreshTray();
    }
  });

  app.whenReady().then(async () => {
    await loadConfig();

    // Auto-start is on by default: a desktop pet you have to launch by hand
    // every morning is a pet you stop using. Applied once, ever — after this
    // the menu switch is the only thing that changes it, so turning it off
    // sticks instead of being re-enabled on the next launch.
    if (!config.autoStartInitialized) {
      config.autoStartInitialized = true;
      saveConfig();
      setAutoStart(true);
    }

    if (Number.isFinite(config.petSize)) {
      petSize = Math.max(MIN_SIZE_PX, Math.min(MAX_SIZE_PX, config.petSize));
    }
    registerIpc();
    await refreshCatalog();
    createPetWindow();
    applyClickThrough();
    // Created topmost, but Windows can drop it back out of the topmost band
    // behind our back — see holdPetOnTop.
    setInterval(holdPetOnTop, TOPMOST_REASSERT_MS);

    tray = new Tray(trayIconImage());
    tray.setToolTip("鲸鱼娘桌宠");
    refreshTray();
    tray.on("click", () => toggleHidden());

    // Tell a first-time user how to reach the menu. Nothing else in the app
    // hints that a right-click or a tray icon exists, and without this the pet
    // reads as an unclosable thing stuck on the desktop.
    //
    // This used to be a tray balloon. The speech bubble says the same thing and
    // says it next to the pet, which is where the user is already looking, and
    // it can be drawn in the app's own blue instead of whatever Windows decides
    // a balloon should look like. The balloon is gone rather than kept
    // alongside: two notices at once, both explaining the same thing, is worse
    // than either one on its own.
    if (!config.firstRunDone) {
      config.firstRunDone = true;
      saveConfig();
      startGreeting();
    }

    // Today's spend only means anything if the balance is sampled through the
    // day, and a desktop pet already runs all day. Ten minutes catches each
    // drop and is rare enough to stay out of the way. This is also the only
    // network traffic the app generates on its own, and it stays silent until
    // the user has saved an API key.
    const pollBalance = () => {
      if (hasApiKey()) showBalance({ silent: true });
    };
    setTimeout(pollBalance, 20000);
    setInterval(pollBalance, BALANCE_POLL_MS);

    // The same reading again on the hour, but spoken this time — see
    // scheduleHourlyBalance.
    scheduleHourlyBalance();

    // 一言 was off by default, so this is a no-op unless a config from a
    // previous run left it switched on.
    scheduleHitokoto();
  });

  app.on("window-all-closed", () => {
    // The pet window is the app; closing it means quitting.
    if (quitting) app.quit();
  });
}
