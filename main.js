// 鲸鱼娘桌宠 — main process.
//
// A standalone Windows desktop pet. No DSH, no server, no Node required on the
// target machine: assets are read from folders next to the executable.
//
// The only network traffic is the optional DeepSeek balance check, which also
// polls on a timer once a key is saved — see BALANCE_POLL_MS.
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

const DEFAULT_SKIN = "默认";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

// What the pet shows before the user has picked anything. It is a reaction, not
// a skin frame: this build has no idle pose, so the startup image is just
// another action — picking something else replaces it and it is remembered.
const DEFAULT_REACTION = "蓝色大肥鱼_打字(普通)_2026-08-18-14-38-34.gif";

// Role -> source filename. Each skin is five GIFs with these names.
const ROLE_FILE = { idleA: "1.gif", thinking: "2.gif", idleB: "3.gif", output: "4.gif", done: "5.gif" };

const PET_SIZE_PX = 220;
const MIN_SIZE_PX = 80;
const MAX_SIZE_PX = 640;
const EDGE_MARGIN = 16;

// How often to sample the balance while the app runs, so "spent today" stays
// meaningful without the user having to click. Only used when a key is saved.
const BALANCE_POLL_MS = 10 * 60 * 1000;



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

let catalog = { skins: [], reactions: [] };
let currentSkin = null;

/** Everything the user can change, persisted as JSON in userData. */
let config = { clickThrough: false, firstRunDone: false, clickSwitch: false };

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
  win.on("moved", rememberPetBounds);
  win.on("resized", rememberPetBounds);
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
    { id: "reset-position", label: "复位位置" },
    { id: "hide-pet", label: hidden ? "显示桌宠" : "隐藏桌宠" },
    { type: "separator" },
    { id: "auto-start", label: "开机自启", type: "check", checked: autoStartEnabled() },
    {
      id: "click-switch",
      label: "点击切换表情",
      type: "check",
      checked: config.clickSwitch === true
    },
    { type: "separator" },
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
    case "click-switch":
      config.clickSwitch = !config.clickSwitch;
      saveConfig();
      send("click-switch", config.clickSwitch);
      refreshTray();
      break;
    case "reaction-random":
      pickRandomReaction();
      break;
    case "browse":
      openPicker();
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
    case "reset-position":
      resetPosition();
      break;
    case "hide-pet":
      toggleHidden();
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
    const period = isPeakNow() ? "高峰时段" : "空闲时段（半价）";
    notify(
      "鲸鱼娘桌宠 · 余额",
      `余额 ${balance.toFixed(2)} ${info.currency} · 今日消费 ${spend.total.toFixed(2)} · ${period}`
    );
  } catch (err) {
    if (silent) return;
    notify("鲸鱼娘桌宠 · 余额查询失败", err && err.message ? err.message : String(err));
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
    { label: "复位位置", click: () => resetPosition() },
    { label: hidden ? "显示桌宠" : "隐藏桌宠", click: () => toggleHidden() },
    { type: "separator" },
    { label: "开机自启", type: "checkbox", checked: autoStartEnabled(), click: () => runMenuCommand("auto-start") },
    { label: "点击切换表情", type: "checkbox", checked: config.clickSwitch === true, click: () => runMenuCommand("click-switch") },
    { type: "separator" },
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
  if (hidden) win.hide();
  else win.showInactive();
  refreshTray();
}

function resetPosition() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(anchorBounds(petSize));
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
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle("pet:catalog", async () => {
    await refreshCatalog();
    // `current` is what the pet should show on launch: the last action picked,
    // falling back to the built-in default when nothing has been picked yet.
    const remembered = config.lastReaction;
    let current = null;
    if (remembered && catalog.reactions.includes(remembered)) current = remembered;
    else if (catalog.reactions.includes(DEFAULT_REACTION)) current = DEFAULT_REACTION;
    else current = catalog.reactions[0] || null;
    return { ...catalog, currentSkin, petSize, current, clickSwitch: config.clickSwitch === true };
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
    // handler is what has to remember the position.
    rememberPetBounds();
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

    tray = new Tray(trayIconImage());
    tray.setToolTip("鲸鱼娘桌宠");
    refreshTray();
    tray.on("click", () => toggleHidden());

    // Tell a first-time user how to reach the menu. Nothing else in the app
    // hints that a right-click or a tray icon exists, and without this the pet
    // reads as an unclosable thing stuck on the desktop.
    if (!config.firstRunDone) {
      config.firstRunDone = true;
      saveConfig();
      setTimeout(() => {
        if (!tray) return;
        try {
          tray.displayBalloon({
            title: "鲸鱼娘桌宠已启动",
            content: "右键桌宠可以看菜单，托盘图标也可以。"
          });
        } catch (_) {
          notify("鲸鱼娘桌宠已启动", "右键桌宠可以看菜单，托盘图标也可以。");
        }
      }, 1500);
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
  });

  app.on("window-all-closed", () => {
    // The pet window is the app; closing it means quitting.
    if (quitting) app.quit();
  });
}
