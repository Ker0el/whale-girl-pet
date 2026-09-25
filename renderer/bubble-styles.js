// Bubble style chooser.
//
// Five options is too many for the menu and too few to need a search box, but
// the names on their own say nothing — "糖果泡" versus "深色玻璃" is not a choice
// anyone can make from words. So each card draws a real bubble using the
// bubble's own stylesheet: what is being compared is the actual thing, not a
// mock-up that can drift away from it.
//
// Picking one applies it immediately and asks main to say something with it,
// which is the only way to judge a bubble at the size it will really be used.
"use strict";

const grid = document.getElementById("grid");

/** Long enough to wrap onto a second line, so the cards show the real shape. */
const SAMPLE = "你好呀，我是鲸鱼娘～\n右键我可以看菜单。";

let selected = null;

function render(styles) {
  grid.textContent = "";
  for (const style of styles) {
    const card = document.createElement("div");
    card.className = "card" + (style.id === selected ? " selected" : "");
    card.dataset.id = style.id;

    const stage = document.createElement("div");
    stage.className = "stage";

    const bubble = document.createElement("div");
    bubble.className = "bubble skin-" + style.id;
    const tail = document.createElement("i");
    tail.className = "tail";
    // textContent, not innerHTML: the sample is ours, but the habit is what
    // keeps a future caller from pasting arbitrary text into the DOM.
    bubble.append(tail, document.createTextNode(SAMPLE));

    const name = document.createElement("div");
    name.className = "name";
    const label = document.createElement("span");
    label.textContent = style.label;
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = style.id === selected ? "✓ 使用中" : "";
    name.append(label, tick);

    stage.append(bubble);
    card.append(stage, name);
    card.addEventListener("click", () => choose(style.id));
    grid.append(card);
  }
}

function choose(id) {
  selected = id;
  for (const card of grid.children) {
    const on = card.dataset.id === id;
    card.classList.toggle("selected", on);
    card.querySelector(".tick").textContent = on ? "✓ 使用中" : "";
  }
  window.petHost.setBubbleStyle(id);
}

async function boot() {
  const state = await window.petHost.bubbleStyles();
  selected = state.current;
  render(state.styles || []);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.closeBubbleStyles();
});

boot().catch(() => {});
