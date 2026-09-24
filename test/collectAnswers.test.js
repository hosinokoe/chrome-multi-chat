// 自检：collectAnswers 的"聚合成分段文本"逻辑（无框架）
// 只复刻纯逻辑部分（拼接 + 计数），不依赖 DOM / chrome API。改实现时请同步这里。
const assert = require("assert");

// 复刻 sidepanel.js collectAnswers 里的文本聚合与计数
function buildAggregate(message, answers) {
  const ok = answers.filter(a => a.success && a.answer);
  const parts = [`【问题】\n${message}\n`];
  for (const a of answers) {
    parts.push(`\n=== ${a.platform} ===\n${a.success && a.answer ? a.answer : `（未收集到：${a.error || "无回答"}）`}`);
  }
  return { count: ok.length, text: parts.join("\n") };
}

// 1) 全部成功：count=2，文本含两个平台分段与各自回答
{
  const r = buildAggregate("2+2=?", [
    { platform: "Gemini", success: true, answer: "4" },
    { platform: "DeepSeek", success: true, answer: "等于 4" }
  ]);
  assert.strictEqual(r.count, 2, "两份成功应计数 2");
  assert.ok(r.text.includes("【问题】\n2+2=?"), "应包含问题");
  assert.ok(r.text.includes("=== Gemini ===\n4"), "应包含 Gemini 回答");
  assert.ok(r.text.includes("=== DeepSeek ===\n等于 4"), "应包含 DeepSeek 回答");
}

// 2) 部分失败：失败项写入占位说明，不计入 count，但仍出现在文本里
{
  const r = buildAggregate("hi", [
    { platform: "Grok", success: true, answer: "hello" },
    { platform: "豆包", success: false, answer: "", error: "未找到回答内容" }
  ]);
  assert.strictEqual(r.count, 1, "仅一份成功");
  assert.ok(r.text.includes("=== Grok ===\nhello"), "成功项含回答");
  assert.ok(r.text.includes("=== 豆包 ===\n（未收集到：未找到回答内容）"), "失败项含占位说明");
}

// 3) 成功但回答为空：不计入 count（success 需搭配非空 answer）
{
  const r = buildAggregate("q", [
    { platform: "Gemini", success: true, answer: "" }
  ]);
  assert.strictEqual(r.count, 0, "success 但 answer 空不计数");
}

console.log("collectAnswers logic: all assertions passed");
