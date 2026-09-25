// Settings window.
//
// The API key is write-only from here: main never sends the stored key back to
// a renderer, only whether one exists. So the field starts empty even when a
// key is configured, and saving replaces it wholesale.
"use strict";

const statusEl = document.getElementById("status");
const storageEl = document.getElementById("storage");
const keyEl = document.getElementById("key");
const saveBtn = document.getElementById("save");
const clearBtn = document.getElementById("clear");
const toastEl = document.getElementById("toast");

let toastTimer = null;

function toast(text, bad) {
  toastEl.textContent = text;
  toastEl.classList.toggle("bad", Boolean(bad));
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

/**
 * Ask main to resize the window to whatever the content currently needs.
 *
 * The status line and the config path both change length — "未配置" versus a
 * long %APPDATA% path — so any fixed height either clips text or grows a
 * scrollbar, and a scrollbar in a four-field dialog reads as broken.
 */
function fitWindow() {
  requestAnimationFrame(() => {
    const chrome = window.outerHeight - window.innerHeight; // title bar + frame
    window.petHost.fitSettings(document.documentElement.scrollHeight + chrome);
  });
}

function renderStatus(state) {
  if (state.hasKey && state.encrypted) {
    statusEl.textContent = "已配置（已用 Windows 凭据加密）";
    statusEl.classList.remove("warn");
  } else if (state.hasKey) {
    statusEl.textContent = "已配置，但本机无法加密，key 以明文保存";
    statusEl.classList.add("warn");
  } else {
    statusEl.textContent = "未配置";
    statusEl.classList.remove("warn");
  }
  clearBtn.disabled = !state.hasKey;
  storageEl.textContent = "配置文件：" + state.configPath;
  fitWindow();
}

async function refresh() {
  const state = await window.petHost.settingsState();
  renderStatus(state);
  return state;
}

saveBtn.addEventListener("click", async () => {
  const value = keyEl.value.trim();
  if (!value) {
    toast("请先填入 key", true);
    keyEl.focus();
    return;
  }
  const result = await window.petHost.saveApiKey(value);
  keyEl.value = "";
  await refresh();
  toast(result.encrypted ? "已保存并加密" : "已保存（未能加密）", !result.encrypted);
});

clearBtn.addEventListener("click", async () => {
  await window.petHost.clearApiKey();
  keyEl.value = "";
  await refresh();
  toast("已清除");
});

keyEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.closeSettings();
});

window.petHost.onFocusKey(() => keyEl.focus());

refresh().catch(() => {
  statusEl.textContent = "读取失败";
  statusEl.classList.add("warn");
  fitWindow();
});
