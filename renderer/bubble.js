// Speech bubble — the greeting that appears next to the pet.
//
// The third instance of the same shape of thing as the menu: a transparent
// frameless window whose size is decided by what the renderer draws, reported
// back to main before the window is shown so it never jumps. Two things differ,
// and both come from what a bubble is for. It is anchored to the pet rather
// than to the cursor, so main places it from the pet's bounds. And it never
// takes focus — main creates it non-activatable, like the pet itself — so it
// cannot be dismissed by blur the way the menu is; it goes away on its own
// timer, or when it is clicked.
"use strict";

// Must match the padding on <body> in bubble.css.
const PAD = 22;

const bubble = document.getElementById("bubble");
const tail = document.querySelector(".tail");
const textEl = document.getElementById("text");

window.petHost.onBubbleShow((msg) => {
  if (!msg || typeof msg.text !== "string") return;
  document.documentElement.style.setProperty("--f", String(msg.scale || 1));
  textEl.textContent = msg.text;
  // The whole class list, not just the skin: styles that outline the bubble
  // change its border, and leaving a stale one behind would keep the old
  // outline's width in the measurement.
  bubble.className = "bubble skin-" + (msg.skin || "classic");
  document.body.classList.toggle("below", msg.placement === "below");

  // Measure straight away rather than from a requestAnimationFrame. rAF does
  // not fire while the page is hidden, and this window is hidden every moment
  // it is not saying something — so deferring the measurement would mean it
  // never came back, main would never be told the size, and the bubble would
  // never be shown again after its first outing. Reading a layout property
  // flushes style and layout synchronously, which is all the ordering that was
  // ever needed here.
  //
  // Only width and height are reported, never a position: that is what makes it
  // safe to measure while the entrance transform is still on <body>.
  const box = bubble.getBoundingClientRect();
  const tip = tail.getBoundingClientRect();
  const width = Math.max(box.right, tip.right) - Math.min(box.left, tip.left);
  const height = Math.max(box.bottom, tip.bottom) - Math.min(box.top, tip.top);
  window.petHost.bubbleSize({
    width: Math.ceil(width) + PAD * 2,
    height: Math.ceil(height) + PAD * 2
  });
});

// Main fades it in only after the window is on screen, so the entrance is never
// spent while it is still hidden.
window.petHost.onBubblePop(() => document.body.classList.add("shown"));

bubble.addEventListener("click", () => window.petHost.bubbleClick());

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.petHost.bubbleClick();
});

// Main may have loaded this window while there was nothing to say; tell it we
// are ready for text in case it already has some waiting.
window.petHost.bubbleReady();
