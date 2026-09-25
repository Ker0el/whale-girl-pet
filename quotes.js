// 一言 — the one-line quote service.
//
// Two sources, because this runs unattended for days and the public endpoint is
// a single point of failure that will be down or rate-limiting eventually. The
// two answer in different shapes: hitokoto.cn carries who said it and what work
// it came from, uapis.cn carries the text alone. Both are reduced to the same
// { text, source } here so nothing downstream has to care which one answered.
"use strict";

/**
 * The sentence types hitokoto.cn documents, in the order its own table lists
 * them. `id` is what goes in the `c` query parameter; `label` is only ever
 * shown to the user.
 *
 * The table ends with a line saying that any other value is treated as 动画.
 * That is a note about the service's own fallback, not a thirteenth choice —
 * asking for it would be the same as asking for 动画, so there is no such
 * entry here. 其他 is a type of its own (g) and does appear.
 */
const CATEGORIES = [
  { id: "a", label: "动画" },
  { id: "b", label: "漫画" },
  { id: "c", label: "游戏" },
  { id: "d", label: "文学" },
  { id: "e", label: "原创" },
  { id: "f", label: "来自网络" },
  { id: "g", label: "其他" },
  { id: "h", label: "影视" },
  { id: "i", label: "诗词" },
  { id: "j", label: "网易云" },
  { id: "k", label: "哲学" },
  { id: "l", label: "抖机灵" }
];

/** What the app asked for before this was configurable, and the fallback. */
const DEFAULT_CATEGORIES = ["d", "f", "h", "i", "j", "k"];

const KNOWN = new Set(CATEGORIES.map((c) => c.id));

const PRIMARY = "https://v1.hitokoto.cn/";
const FALLBACK = "https://uapis.cn/api/v1/saying";

/** How long either endpoint gets before it is written off and the next is tried. */
const SOURCE_TIMEOUT_MS = 8000;

/** Long entries make a tall bubble; this is a guard, not a rule. */
const MAX_TEXT_CHARS = 120;

/**
 * Keep only ids this build knows about, de-duplicated and put back into the
 * documented order.
 *
 * The list comes out of a config file and off a set of checkboxes, so it is
 * filtered rather than trusted: an unknown id would be sent to the service as
 * a category it does not have, and the service answers unknown ids with 动画,
 * which would silently mean something other than what the user picked.
 */
function normaliseCategories(value) {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((id) => KNOWN.has(id)));
  return CATEGORIES.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

/**
 * The hitokoto.cn endpoint for a set of categories.
 *
 * An empty set produces no `c` parameter at all, which the service answers with
 * a sentence of any type. That is the only sensible reading of "不限": asking
 * for the empty set explicitly would return nothing, and falling back to the
 * default six would quietly ignore the choice.
 */
function endpoint(categories) {
  const list = normaliseCategories(categories);
  if (list.length === 0) return PRIMARY;
  return PRIMARY + "?" + list.map((id) => `c=${id}`).join("&");
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function fromHitokotoCn(data) {
  let text = clean(data && data.hitokoto);
  if (!text) return null;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "…";

  // from_who is the person, from is the work. An entry may carry either, both,
  // or neither, so the attribution is assembled from whatever is there rather
  // than assuming a shape.
  const who = clean(data.from_who);
  const work = clean(data.from);
  const source = who && work ? `${who}《${work}》` : who || work;
  return { text, source };
}

function fromUapis(data) {
  let text = clean(data && data.text);
  if (!text) return null;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "…";
  return { text, source: "" };
}

/**
 * One quote, trying each source in turn.
 *
 * Resolves null when every source failed — a caller that cannot say anything is
 * better than one that says "加载失败", so the failure is silent and the next
 * tick tries again.
 */
async function fetchOne(categories, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const sources = [
    { url: endpoint(categories), pick: fromHitokotoCn },
    // The fallback takes no category parameter at all. So a user who picked
    // only 网易云 still gets an arbitrary sentence when the primary is down,
    // rather than nothing at all — degraded, but not silent.
    { url: FALLBACK, pick: fromUapis }
  ];

  for (const source of sources) {
    try {
      const res = await doFetch(source.url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
      if (!res.ok) continue;
      const picked = source.pick(JSON.parse(await res.text()));
      if (picked) return picked;
    } catch (_) {
      // Whatever went wrong, the next source is the answer.
    }
  }
  return null;
}

/** The two lines the bubble shows: the quote, then its attribution if it has one. */
function render(quote) {
  if (!quote || !quote.text) return "";
  return quote.source ? `${quote.text}\n—— ${quote.source}` : quote.text;
}

module.exports = {
  CATEGORIES,
  DEFAULT_CATEGORIES,
  normaliseCategories,
  endpoint,
  fetchOne,
  render,
  MAX_TEXT_CHARS
};
