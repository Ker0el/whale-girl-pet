// Checks for peak.js. Run with: node tools/test-peak.js
//
// Every case is written in Beijing time and converted to UTC here, so the
// result does not depend on the machine's own timezone.
"use strict";

const { isPeakNow } = require("../peak");

/** A Beijing wall-clock moment, as a Date. */
function beijing(y, m, d, hh, mm = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
}

const cases = [
  // [label, Date, expectPeak]
  ["周五 09:00 (上班)", beijing(2026, 9, 28, 9, 0), true],
  ["周五 08:59 (差一分钟)", beijing(2026, 9, 28, 8, 59), false],
  ["周五 10:00", beijing(2026, 9, 28, 10, 0), true],
  ["周五 12:00 (午休开始)", beijing(2026, 9, 28, 12, 0), false],
  ["周五 13:00 (午休中)", beijing(2026, 9, 28, 13, 0), false],
  ["周五 14:00 (下午开始)", beijing(2026, 9, 28, 14, 0), true],
  ["周五 17:59", beijing(2026, 9, 28, 17, 59), true],
  ["周五 18:00 (下班)", beijing(2026, 9, 28, 18, 0), false],
  ["周五 23:00 (深夜)", beijing(2026, 9, 28, 23, 0), false],

  ["周六 10:00", beijing(2026, 9, 26, 10, 0), false],
  ["周日 15:00", beijing(2026, 9, 27, 15, 0), false],
  ["周日 10:00 (调休上班日 9/20 同型)", beijing(2026, 9, 20, 10, 0), false],

  ["中秋假期首日 周五 15:00", beijing(2026, 9, 25, 15, 0), false],
  ["中秋假期末日 周日 10:00", beijing(2026, 9, 27, 10, 0), false],
  ["节后周四 10:00 (恢复正常)", beijing(2026, 10, 8, 10, 0), true],

  ["元旦 周四 10:00", beijing(2026, 1, 1, 10, 0), false],
  ["元旦次日 周五 10:00", beijing(2026, 1, 2, 10, 0), false],

  ["春节中 周一 10:00", beijing(2026, 2, 16, 10, 0), false],
  ["春节后 周一 10:00", beijing(2026, 3, 2, 10, 0), true],

  ["劳动节 周一 10:00", beijing(2026, 5, 4, 10, 0), false],
  ["劳动节后 周一 10:00", beijing(2026, 5, 11, 10, 0), true],

  ["端午 周五 10:00", beijing(2026, 6, 19, 10, 0), false],
  ["国庆中 周四 15:00", beijing(2026, 10, 1, 15, 0), false],
  ["国庆末日 周三 10:00", beijing(2026, 10, 7, 10, 0), false],

  ["普通周三 10:00", beijing(2026, 7, 15, 10, 0), true],
  ["普通周三 20:00", beijing(2026, 7, 15, 20, 0), false]
];

let failed = 0;
for (const [label, when, expect] of cases) {
  const got = isPeakNow(when);
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(30)} 期望 ${expect ? "高峰" : "空闲"}  实际 ${got ? "高峰" : "空闲"}`);
}

console.log();
console.log(failed === 0 ? `全部通过（${cases.length} 项）` : `${failed}/${cases.length} 项失败`);
process.exit(failed === 0 ? 0 : 1);
