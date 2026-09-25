// Custom right-click menu.
//
// A native Electron menu is styled by Windows and cannot match the pet, so the
// menu is drawn here instead. Two consequences are handled in this file and in
// main's placeMenu(): reporting the laid-out size back so the window can be
// sized and flipped near a screen edge, and closing on Escape (main closes it
// on blur, which covers clicking anywhere else).
"use strict";

const MENU_PAD = 14; // must match the padding on <body> in menu.css
const menu = document.getElementById("menu");

menu.addEventListener("contextmenu", (e) => e.preventDefault());

window.petHost.onMenuItems((items) => {
  menu.textContent = "";
  for (const item of items) {
    if (item.type === "separator") {
      const sep = document.createElement("div");
      sep.className = "separator";
      menu.append(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = "item" + (item.enabled === false ? " disabled" : "");
    row.setAttribute("role", "menuitem");

    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = item.type === "check" && item.checked ? "✓" : "";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = item.label;

    row.append(tick, label);
    if (item.enabled !== false) {
      row.addEventListener("click", () => window.petHost.menuCommand(item.id));
    }
    menu.append(row);
  }

  // Measure after layout and let main position the window. The window is hidden
  // until this lands, so the user never sees it jump from a provisional size.
  const rect = menu.getBoundingClientRect();
  window.petHost.menuSize({
    width: Math.ceil(rect.width) + MENU_PAD * 2,
    height: Math.ceil(rect.height) + MENU_PAD * 2
  });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.menuCommand(null);
});

// Tell main we are ready for items in case it loaded us before wiring handlers.
window.petHost.menuReady();
