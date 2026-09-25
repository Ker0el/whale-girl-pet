// DeepSeek peak / off-peak pricing clock.
//
// Kept out of main.js so it can be exercised directly: it is pure date maths,
// and the only part of this app where being wrong costs the user real money
// (off-peak is half price).
"use strict";

/**
 * Chinese public holidays, from 国务院办公厅关于 2026 年部分节假日安排的通知
 * (国办发明电〔2025〕7 号).
 *
 * Only the 放假 dates are listed. The 调休 swap days — weekends turned into
 * workdays — are deliberately omitted: DeepSeek's rule is "Monday to Friday,
 * excluding Chinese public holidays", so a Saturday swapped into a workday is
 * still a Saturday and still off-peak.
 *
 * A new year needs a new entry once the State Council publishes the schedule.
 * A year with no entry falls back to the weekday rule alone.
 */
const CN_HOLIDAYS = {
  2026: new Set([
    // 元旦
    "2026-01-01", "2026-01-02", "2026-01-03",
    // 春节
    "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
    "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
    // 清明节
    "2026-04-04", "2026-04-05", "2026-04-06",
    // 劳动节
    "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
    // 端午节
    "2026-06-19", "2026-06-20", "2026-06-21",
    // 中秋节
    "2026-09-25", "2026-09-26", "2026-09-27",
    // 国庆节
    "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
    "2026-10-06", "2026-10-07"
  ])
};

/** YYYY-MM-DD as read by the local getters of whatever Date is passed. */
function dateKey(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shift a moment so its local getters read Beijing time. */
function toBeijing(now) {
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
}

/**
 * Whether DeepSeek is billing peak rates at the given moment.
 *
 * Peak is 01:00-04:00 and 06:00-10:00 UTC on weekdays — 09:00-12:00 and
 * 14:00-18:00 Beijing time, Monday to Friday, excluding Chinese public
 * holidays. Everything else is off-peak, at half price.
 *
 * Resolved in Beijing time regardless of this machine's clock, because that is
 * how the rule is written.
 */
function isPeakNow(now = new Date()) {
  const beijing = toBeijing(now);
  const weekday = beijing.getDay(); // 0 Sunday .. 6 Saturday
  if (weekday === 0 || weekday === 6) return false;
  if (CN_HOLIDAYS[beijing.getFullYear()]?.has(dateKey(beijing))) return false;
  const hour = beijing.getHours() + beijing.getMinutes() / 60;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

module.exports = { isPeakNow, toBeijing, dateKey, CN_HOLIDAYS };
