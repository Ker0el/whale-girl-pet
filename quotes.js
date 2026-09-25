// 一言 — the one-line quote service.
//
// Two sources, because this runs unattended for days and the public endpoint is
// a single point of failure that will be down or rate-limiting eventually. The
// two answer in different shapes: hitokoto.cn carries who said it and what work
// it came from, uapis.cn carries the text alone. Both are reduced to the same
// { text, source } here so nothing downstream has to care which one answered.
"use strict";

const SOURCES = [
  { url: "https://v1.hitokoto.cn/?c=d&c=f&c=h&c=i&c=j&c=k", pick: fromHitokotoCn },
  { url: "https://uapis.cn/api/v1/saying", pick: fromUapis }
];

/** How long either endpoint gets before it is written off and the next is tried. */
const SOURCE_TIMEOUT_MS = 8000;

/** Long entries make a tall bubble; this is a guard, not a rule. */
const MAX_TEXT_CHARS = 120;

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
async function fetchOne(fetchImpl) {
  const doFetch = fetchImpl || fetch;
  for (const source of SOURCES) {
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

module.exports = { fetchOne, render, MAX_TEXT_CHARS };
