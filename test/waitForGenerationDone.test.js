// 自检：waitForGenerationDone 的阶段3"文本稳定判定"纯逻辑（无框架，不依赖 DOM）。
// 复刻判定：喂入一串 { text, stop } 快照序列，返回"判定结束时已消费的快照数"（-1=到序列结束仍未判定结束）。
// 改 content.js 的 waitForGenerationDone 阶段3 逻辑时请同步这里。
const assert = require("assert");

const STABLE_NEEDED = 5;

// 复刻阶段3：连续 STABLE_NEEDED 次文本既不变也不变长才算结束；停止按钮再现或文本变长则重置。
function runStablePhase(snapshots) {
  let last = null, maxLen = 0, stableCount = 0;
  for (let i = 0; i < snapshots.length; i++) {
    const { text, stop } = snapshots[i];
    if (stop) { stableCount = 0; continue; }
    const cur = text || "";
    if (cur.length > maxLen) { maxLen = cur.length; stableCount = 0; last = cur; }
    else if (cur && cur === last) { if (++stableCount >= STABLE_NEEDED) return i + 1; }
    else { stableCount = 0; last = cur; }
  }
  return -1;
}

// 1) 文本持续变长（流式生成中）→ 不应判定结束
{
  const snaps = Array.from({ length: 10 }, (_, i) => ({ text: "a".repeat(i + 1), stop: false }));
  assert.strictEqual(runStablePhase(snaps), -1, "文本一直变长不应结束");
}

// 2) 变长后稳定足够次数 → 应在第 5 次稳定处结束
{
  const snaps = [
    { text: "hello", stop: false },        // 变长
    { text: "hello world", stop: false },  // 变长
    // 之后稳定 5 次
    { text: "hello world", stop: false },
    { text: "hello world", stop: false },
    { text: "hello world", stop: false },
    { text: "hello world", stop: false },
    { text: "hello world", stop: false },  // 第5次稳定 → 结束
    { text: "hello world", stop: false }
  ];
  assert.strictEqual(runStablePhase(snaps), 7, "变长后连续5次稳定应在第7个快照判定结束");
}

// 3) 生成中途停顿(不足5次)后又变长 → 不应被误判为结束；且变长后稳定次数不足5也不结束
{
  const snaps = [
    { text: "part1", stop: false },
    { text: "part1", stop: false }, // 停顿1
    { text: "part1", stop: false }, // 停顿2
    { text: "part1part2", stop: false }, // 又变长，重置(此次不算稳定)
    { text: "part1part2", stop: false }, // 稳定1
    { text: "part1part2", stop: false }, // 稳定2
    { text: "part1part2", stop: false }, // 稳定3
    { text: "part1part2", stop: false }  // 稳定4 → 不足5，不结束
  ];
  assert.strictEqual(runStablePhase(snaps), -1, "变长后仅稳定4次不足5次，不应判定结束");
}

// 4) 停止按钮再现 → 重置稳定计数
{
  const snaps = [
    { text: "done", stop: false },
    { text: "done", stop: false },
    { text: "done", stop: false },
    { text: "done", stop: true },   // 停止按钮再现，重置
    { text: "done", stop: false },
    { text: "done", stop: false },
    { text: "done", stop: false },
    { text: "done", stop: false },
    { text: "done", stop: false }   // 重置后第5次 → 结束
  ];
  assert.strictEqual(runStablePhase(snaps), 9, "停止按钮再现应重置计数");
}

console.log("waitForGenerationDone stable-phase logic: all assertions passed");
