// 一言 interval settings.
//
// A window rather than a row in the menu for the same reason the styles have
// one: a number that can be anything from 1 to 1440 does not fit on a menu,
// and the presets people actually want need to be one click rather than five
// presses of a spinner.
"use strict";

const presets = document.getElementById("presets");
const custom = document.getElementById("custom");
const status = document.getElementById("status");

let state = null;

function paint() {
  // Nothing is drawn until the real setting arrives. Painting the defaults
  // first would put 「已关闭」 on screen for a moment in a window that is about
  // to report that 一言 is on, which reads as a setting that failed to stick.
  if (!state) return;
  for (const button of presets.children) {
    button.classList.toggle("on", Number(button.dataset.min) === state.minutes);
  }
  custom.value = String(state.minutes);
  status.textContent = state.on
    ? `已开启，每 ${state.minutes} 分钟说一句。`
    : `已关闭。打开后每 ${state.minutes} 分钟说一句。`;
}

function apply(minutes) {
  // Main clamps whatever arrives — the field takes free text — and sends the
  // state back, so paint() here only ever reflects what was actually stored.
  window.petHost.setHitokotoMinutes(minutes);
}

presets.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-min]");
  if (button) apply(Number(button.dataset.min));
});

document.getElementById("save").addEventListener("click", () => apply(Number(custom.value)));

custom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") apply(Number(custom.value));
});

document.getElementById("preview").addEventListener("click", () => window.petHost.previewHitokoto());
document.getElementById("close").addEventListener("click", () => window.petHost.closeHitokoto());

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.closeHitokoto();
});

window.petHost.onHitokotoState((next) => {
  state = next;
  paint();
});

window.petHost
  .hitokotoState()
  .then((next) => {
    state = next;
    paint();
  })
  .catch(() => {
    status.textContent = "读取设置失败，重开这个窗口试试。";
  });
