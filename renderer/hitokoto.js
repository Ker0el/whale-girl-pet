// 一言 settings: how often, and what kind of sentences.
//
// A window rather than rows in the menu for the same reason the bubble styles
// have one: a number that can be anything from 1 to 1440 does not fit on a
// menu, and neither do twelve checkboxes.
"use strict";

const presets = document.getElementById("presets");
const categoriesEl = document.getElementById("categories");
const custom = document.getElementById("custom");
const status = document.getElementById("status");

let state = null;
/** The checkboxes are built once and then only synced, so focus survives. */
let built = false;

function paintStatus() {
  status.textContent = state.on
    ? `已开启，每 ${state.minutes} 分钟说一句。`
    : `已关闭。打开后每 ${state.minutes} 分钟说一句。`;
}

function paintCategories() {
  // The list of types comes from main rather than from a copy kept here, so a
  // type this build does not know about can never be offered and then quietly
  // dropped from the request.
  if (!built) {
    for (const category of state.available || []) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = category.id;
      box.addEventListener("change", () => toggle(category.id, box.checked));
      const text = document.createElement("span");
      text.textContent = category.label;
      label.append(box, text);
      categoriesEl.append(label);
    }
    built = true;
  }

  const chosen = new Set(state.categories || []);
  for (const label of categoriesEl.children) {
    const box = label.querySelector("input");
    box.checked = chosen.has(box.value);
    label.classList.toggle("on", box.checked);
  }
}

function paint() {
  // Nothing is drawn until the real setting arrives. Painting the defaults first
  // would put 「已关闭」 on screen for a moment in a window that is about to
  // report that 一言 is on, which reads as a setting that failed to stick.
  if (!state) return;

  for (const button of presets.children) {
    button.classList.toggle("on", Number(button.dataset.min) === state.minutes);
  }
  custom.value = String(state.minutes);
  paintStatus();
  paintCategories();
}

function toggle(id, on) {
  const next = new Set(state.categories || []);
  if (on) next.add(id);
  else next.delete(id);
  // Applied locally first so the row lights up under the click, then main
  // answers with the authoritative list and paint() corrects anything that was
  // filtered out.
  state.categories = [...next];
  paintCategories();
  window.petHost.setHitokotoCategories([...next]);
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
