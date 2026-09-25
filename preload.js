// Narrow bridge between the renderers and the main process.
//
// All four windows share this one preload. They run with contextIsolation on
// and no Node access, so window movement, menu commands, asset bytes and the
// API key all have to cross this boundary explicitly.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petHost", {
  // --- pet window ---
  /** Toggle whether the transparent window swallows mouse events. */
  setInteractive: (want) => ipcRenderer.send("pet:interactive", !!want),
  /** Move the window by a screen-space delta (CSS px == DIP). */
  drag: (dx, dy) => ipcRenderer.send("pet:drag", { dx, dy }),
  /** Resize the window, keeping the bottom-right corner pinned. */
  resize: (size) => ipcRenderer.send("pet:resize", size),
  /** Hand the main process a thumbnail so the tray can show the current skin. */
  setTrayIcon: (dataUrl) => ipcRenderer.send("pet:tray-icon", dataUrl),
  /** Pop the custom menu at the cursor. */
  contextMenu: () => ipcRenderer.send("pet:context-menu"),
  /** Skin + reaction catalog, read from the folders next to the app. */
  catalog: () => ipcRenderer.invoke("pet:catalog"),
  /**
   * One GIF's bytes. kind is "skin" (a = skin name, b = role) or "reaction"
   * (a = filename). Returns null when the file is missing.
   */
  asset: (kind, a, b) => ipcRenderer.invoke("pet:asset", kind, a, b),
  /** Commands issued from the menu or the tray. */
  onExec: (handler) => ipcRenderer.on("pet:exec", (_event, msg) => handler(msg)),

  // --- menu window ---
  onMenuItems: (handler) => ipcRenderer.on("menu:items", (_event, items) => handler(items)),
  /** Report the laid-out menu size so main can size and place the window. */
  menuSize: (size) => ipcRenderer.send("pet:menu-size", size),
  /** Activate a menu entry. `id` is a string, or null to just dismiss. */
  menuCommand: (id) => ipcRenderer.send("pet:menu-command", id),
  menuReady: () => ipcRenderer.send("pet:menu-ready"),
  closeMenu: () => ipcRenderer.send("pet:menu-close"),

  // --- action picker ---
  openPicker: () => ipcRenderer.send("pet:open-picker"),
  playReaction: (name) => ipcRenderer.send("pet:play-reaction", name),
  /** Ask main for a random action — it owns the choice so it can remember it. */
  randomReaction: () => ipcRenderer.send("pet:random-reaction"),
  closePicker: () => ipcRenderer.send("pet:picker-close"),

  // --- settings ---
  settingsState: () => ipcRenderer.invoke("settings:state"),
  saveApiKey: (key) => ipcRenderer.invoke("settings:save-key", key),
  clearApiKey: () => ipcRenderer.invoke("settings:clear-key"),
  /** Resize the settings window to the given outer height. */
  fitSettings: (height) => ipcRenderer.send("settings:fit", height),
  closeSettings: () => ipcRenderer.send("settings:close"),

  // --- tip window ---
  tipImage: () => ipcRenderer.invoke("tip:image"),
  fitTip: (height) => ipcRenderer.send("tip:fit", height),
  closeTip: () => ipcRenderer.send("tip:close"),
  onFocusKey: (handler) => ipcRenderer.on("settings:focus-key", () => handler())
});
