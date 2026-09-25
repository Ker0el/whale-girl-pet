// Action browser.
//
// A menu can hold ten things; this holds 157 with previews, so it is a real
// window. Frames load lazily through an IntersectionObserver — the pack is
// 460 MB, and pulling all of it into a grid at once would be both slow and
// pointless when only a screenful is visible.
"use strict";

const grid = document.getElementById("grid");
const search = document.getElementById("search");
const countEl = document.getElementById("count");
const emptyEl = document.getElementById("empty");

/** name -> blob URL, kept across re-renders so filtering never refetches. */
const thumbs = new Map();
/** names whose bytes are currently in flight. */
const loading = new Set();

let names = [];
let visible = [];

function label(name) {
  return name.replace(/^蓝色大肥鱼_/, "").replace(/_2026-.*\.gif$/, "");
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const name = entry.target.dataset.name;
      if (name) loadThumb(name).catch(() => {});
    }
  },
  { root: grid, rootMargin: "200px" }
);

async function loadThumb(name) {
  if (thumbs.has(name) || loading.has(name)) return;
  loading.add(name);
  try {
    const bytes = await window.petHost.asset("reaction", name);
    if (!bytes || !bytes.length) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
    thumbs.set(name, url);
    // The cell may have been re-rendered away while this was in flight.
    const live = grid.querySelector(`.cell[data-name="${CSS.escape(name)}"] img`);
    if (live) live.src = url;
  } finally {
    loading.delete(name);
  }
}

function render() {
  observer.disconnect();
  grid.textContent = "";

  const q = search.value.trim().toLowerCase();
  visible = q ? names.filter((n) => label(n).toLowerCase().includes(q)) : names;

  countEl.textContent = `${visible.length} / ${names.length}`;
  emptyEl.hidden = visible.length > 0;

  const frag = document.createDocumentFragment();
  for (const name of visible) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.name = name;
    cell.title = label(name);

    const img = document.createElement("img");
    // Deliberately empty alt. The name is already rendered in the span below,
    // and a non-empty alt on an image that has no source yet makes Chromium
    // paint placeholder text — then a broken-image glyph if the load fails —
    // for the split second before the thumbnail arrives.
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("error", () => img.removeAttribute("src"));
    const cached = thumbs.get(name);
    if (cached) img.src = cached;

    const span = document.createElement("span");
    span.textContent = label(name);

    cell.append(img, span);
    cell.addEventListener("click", () => window.petHost.playReaction(name));
    frag.append(cell);
  }
  grid.append(frag);

  // Only cells with no cached frame need watching.
  for (const cell of grid.children) {
    if (!thumbs.has(cell.dataset.name)) observer.observe(cell);
  }
  grid.scrollTop = 0;
}

async function boot() {
  const cat = await window.petHost.catalog();
  names = Array.isArray(cat.reactions) ? cat.reactions : [];
  if (names.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent = "找不到表情素材";
    countEl.textContent = "";
    return;
  }
  render();
}

let searchTimer = null;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 120);
});

document.getElementById("random").addEventListener("click", () => {
  if (names.length === 0) return;
  window.petHost.playReaction(names[Math.floor(Math.random() * names.length)]);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.closePicker();
});

search.focus();
boot().catch(() => {
  emptyEl.hidden = false;
  emptyEl.textContent = "加载失败";
});
