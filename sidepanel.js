// Side Panel 主逻辑

const PLATFORMS = {
  chatgpt: { name: "ChatGPT", patterns: ["chatgpt.com", "chat.openai.com"], newChatUrl: "https://chatgpt.com/" },
  gemini: { name: "Gemini", patterns: ["gemini.google.com"], newChatUrl: "https://gemini.google.com/app" },
  tongyi: { name: "通义千问", patterns: ["tongyi.aliyun.com", "tongyi.com", "qianwen.com"], newChatUrl: "https://www.qianwen.com/" },
  deepseek: { name: "DeepSeek", patterns: ["chat.deepseek.com"], newChatUrl: "https://chat.deepseek.com/" },
  zai: { name: "Z.AI", patterns: ["chat.z.ai"], newChatUrl: "https://chat.z.ai/" },
  grok: { name: "Grok", patterns: ["grok.com"], newChatUrl: "https://grok.com/" },
  doubao: { name: "豆包", patterns: ["doubao.com"], newChatUrl: "https://www.doubao.com/chat/" },
  // Claude 爱封号、Kimi 额度限制多，排在最后且默认不选
  claude: { name: "Claude", patterns: ["claude.ai"], newChatUrl: "https://claude.ai/new" },
  kimi: { name: "Kimi", patterns: ["kimi.moonshot.cn", "www.kimi.com"], newChatUrl: "https://www.kimi.com/" }
};

// "默认"勾选时排除的平台（Claude/Kimi）
const DEFAULT_UNCHECKED = ["claude", "kimi"];

// 支持"搜索历史对话"的平台（与 content.js SEARCH_ADAPTERS 保持一致）
const SEARCH_SUPPORTED = ["gemini", "tongyi", "deepseek", "grok"];

// 支持"收集回答"的平台（与 content.js ANSWER_ADAPTERS 保持一致）
const COLLECT_SUPPORTED = ["chatgpt", "gemini", "tongyi", "deepseek", "grok", "doubao"];

// 当前模式："send"（群发消息）| "search"（搜索历史）
let currentMode = "send";

const HISTORY_KEY = "multiChatHistory";
const MODE_KEY = "multiChatModes";
const THEME_KEY = "multiChatTheme";
const LIMITS_KEY = "multiChatLimits"; // { [platformKey]: limitedUntil(ms) }
const MAX_HISTORY = 100;

// 平台限制状态：{ platformKey: limitedUntil(ms) }，到期自动清除
let platformLimits = {};

// 每个平台的展示项：已打开的带 tab 信息，未打开的 tab 为 null
let platformList = []; // [{ key, name, newChatUrl, tab: {id,title,favIconUrl} | null }]
let tabModes = {}; // { tabId: "new" | "continue" }
let historyCache = []; // 完整历史（未过滤），供搜索复用
let historyQuery = ""; // 当前历史搜索关键词（小写）

document.addEventListener("DOMContentLoaded", async () => {
  await loadTheme();
  await loadModes();
  await loadLimits();
  await detectPlatforms();
  await loadHistory();
  setupEventListeners();
});

// ============ 主题管理 ============

async function loadTheme() {
  const data = await chrome.storage.local.get(THEME_KEY);
  const theme = data[THEME_KEY] || "light";
  applyTheme(theme);
}

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    // 亮色模式显示月亮（点击切到暗色），暗色模式显示太阳（点击切回亮色）
    btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn.title = theme === "dark" ? "切换到亮色" : "切换到暗色";
  }
}

async function toggleTheme() {
  const current = document.body.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  await chrome.storage.local.set({ [THEME_KEY]: next });
}

// ============ 模式管理 ============

async function loadModes() {
  const data = await chrome.storage.local.get(MODE_KEY);
  tabModes = data[MODE_KEY] || {};
}

async function saveModes() {
  await chrome.storage.local.set({ [MODE_KEY]: tabModes });
}

// ============ 限制状态管理 ============

// 载入限制状态，顺便清理已到期的
async function loadLimits() {
  const data = await chrome.storage.local.get(LIMITS_KEY);
  platformLimits = data[LIMITS_KEY] || {};
  purgeExpiredLimits();
}

// 清除已到期（limitedUntil <= now）的限制记录，返回是否有变化
function purgeExpiredLimits() {
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(platformLimits)) {
    if (!platformLimits[key] || platformLimits[key] <= now) {
      delete platformLimits[key];
      changed = true;
    }
  }
  if (changed) chrome.storage.local.set({ [LIMITS_KEY]: platformLimits });
  return changed;
}

// 记录某平台被限制到 limitedUntil；成功发送时传 null 解除限制
function setPlatformLimit(platformKey, limitedUntil) {
  if (limitedUntil && limitedUntil > Date.now()) {
    platformLimits[platformKey] = limitedUntil;
  } else {
    delete platformLimits[platformKey];
  }
  chrome.storage.local.set({ [LIMITS_KEY]: platformLimits });
}

function isLimited(platformKey) {
  const until = platformLimits[platformKey];
  return !!(until && until > Date.now());
}

function getTabMode(tabId) {
  return tabModes[tabId] || "continue";
}

function setTabMode(tabId, mode) {
  tabModes[tabId] = mode;
  saveModes();
}

function setAllModes(mode) {
  for (const p of platformList) {
    if (p.tab) {
      tabModes[p.tab.id] = mode;
    }
  }
  saveModes();
  // 更新所有下拉框的显示
  document.querySelectorAll(".tab-mode").forEach(select => {
    select.value = mode;
    select.className = `tab-mode mode-${mode}`;
  });
}

// ============ 平台检测（展示所有支持的平台） ============

async function detectPlatforms() {
  const tabListEl = document.getElementById("tab-list");

  try {
    const tabs = await chrome.tabs.query({});

    // 为每个支持的平台找到对应的已打开标签页（如果有）
    platformList = Object.entries(PLATFORMS).map(([key, config]) => {
      const matchedTab = tabs.find(t => {
        const p = identifyPlatform(t.url);
        return p && p.key === key;
      });

      return {
        key: key,
        name: config.name,
        newChatUrl: config.newChatUrl,
        tab: matchedTab ? {
          id: matchedTab.id,
          title: matchedTab.title,
          favIconUrl: matchedTab.favIconUrl
        } : null
      };
    });

    // 先清掉过期限制，再排序：正常平台 → 被限制平台 → Claude/Kimi（永远最后）。
    // 各档内保持原始顺序（稳定排序）。
    purgeExpiredLimits();
    const rank = (p) => {
      if (DEFAULT_UNCHECKED.includes(p.key)) return 2; // Claude/Kimi 固定最后
      if (isLimited(p.key)) return 1;                  // 额度受限，排到正常之后
      return 0;                                        // 正常
    };
    platformList.sort((a, b) => rank(a) - rank(b));

    renderPlatformList(tabListEl);
    updateTargetCount();
  } catch (err) {
    tabListEl.innerHTML = `<div class="empty">检测失败: ${err.message}</div>`;
  }
}

function identifyPlatform(url) {
  if (!url) return null;
  for (const [key, config] of Object.entries(PLATFORMS)) {
    if (config.patterns.some(pattern => url.includes(pattern))) {
      return { key, ...config };
    }
  }
  return null;
}

function renderPlatformList(container) {
  const openedCount = platformList.filter(p => p.tab).length;
  document.getElementById("tab-hint").textContent = `(${openedCount}/${platformList.length} 已打开)`;

  container.innerHTML = platformList.map((p, index) => {
    const isOpen = !!p.tab;
    const mode = isOpen ? getTabMode(p.tab.id) : null;

    // 搜索模式下：不支持搜索的平台灰掉且不勾选
    const unsupported = currentMode === "search" && !SEARCH_SUPPORTED.includes(p.key);

    // 初始默认勾选：已打开的平台（搜索模式下不支持的平台不勾）
    const checked = (isOpen && !unsupported) ? "checked" : "";
    const statusBadge = isOpen
      ? ""
      : `<span class="platform-status-closed">未打开</span>`;

    // 额度受限徽标：显示恢复时间（如 14:51 恢复）
    const limited = isLimited(p.key);
    const limitBadge = limited
      ? `<span class="platform-status-limited">${formatResetTime(platformLimits[p.key])} 恢复</span>`
      : "";

    // 已打开显示模式下拉；未打开显示固定的"打开并发送"标记
    const modeControl = isOpen
      ? `<select class="tab-mode mode-${mode}" data-tab-id="${p.tab.id}">
           <option value="continue" ${mode === "continue" ? "selected" : ""}>继续</option>
           <option value="new" ${mode === "new" ? "selected" : ""}>新对话</option>
         </select>`
      : `<span class="tab-mode-open">打开</span>`;

    const iconHtml = isOpen && p.tab.favIconUrl
      ? `<img class="platform-icon" src="${p.tab.favIconUrl}" alt="">`
      : `<span class="platform-icon-placeholder">💬</span>`;

    return `
    <label class="tab-item ${isOpen ? "" : "tab-item-closed"} ${unsupported ? "unsupported" : ""}">
      <input type="checkbox" data-index="${index}" ${checked} ${unsupported ? "disabled" : ""}>
      ${iconHtml}
      <span class="tab-title" title="${isOpen ? p.tab.title : p.name}">${p.name}</span>
      ${statusBadge}
      ${limitBadge}
      ${modeControl}
    </label>
  `}).join("");

  // 绑定已打开平台的模式下拉框
  container.querySelectorAll(".tab-mode").forEach(select => {
    select.addEventListener("change", (e) => {
      e.stopPropagation();
      const tabId = parseInt(select.dataset.tabId);
      const mode = select.value;
      setTabMode(tabId, mode);
      select.className = `tab-mode mode-${mode}`;
    });
    select.addEventListener("click", (e) => e.stopPropagation());
  });
}

function updateTargetCount() {
  const checked = document.querySelectorAll("#tab-list input[type='checkbox']:checked");
  document.getElementById("target-count").textContent = checked.length;
}

// ============ 事件监听 ============

function setupEventListeners() {
  // 主题切换
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

  // 刷新平台列表
  document.getElementById("refresh-tabs").addEventListener("click", detectPlatforms);

  // 统一模式设置
  document.getElementById("global-mode").addEventListener("change", (e) => {
    setAllModes(e.target.value);
  });

  // 全选/取消
  document.getElementById("select-all").addEventListener("click", () => {
    document.querySelectorAll("#tab-list input[type='checkbox']").forEach(cb => cb.checked = true);
    updateTargetCount();
  });
  document.getElementById("deselect-all").addEventListener("click", () => {
    document.querySelectorAll("#tab-list input[type='checkbox']").forEach(cb => cb.checked = false);
    updateTargetCount();
  });
  // 默认：选中除 Claude/Kimi 外的所有平台
  document.getElementById("select-default").addEventListener("click", () => {
    document.querySelectorAll("#tab-list input[type='checkbox']").forEach(cb => {
      const p = platformList[parseInt(cb.dataset.index)];
      cb.checked = p ? !DEFAULT_UNCHECKED.includes(p.key) : false;
    });
    updateTargetCount();
  });

  // checkbox 变化
  document.getElementById("tab-list").addEventListener("change", (e) => {
    if (e.target.type === "checkbox") {
      updateTargetCount();
    }
  });

  // 模式切换：群发消息 / 搜索历史
  document.querySelectorAll(".mode-tab").forEach(btn => {
    btn.addEventListener("click", () => switchMode(btn.dataset.mode));
  });

  // 发送 / 搜索（按当前模式分派）
  document.getElementById("send-btn").addEventListener("click", handlePrimaryAction);

  // 手动收集当前勾选平台的最新回答
  document.getElementById("collect-btn").addEventListener("click", () => handleCollect(false));

  // 补收失败：对比上次下载结果，只重收上次失败/未收到的平台
  document.getElementById("collect-failed-btn").addEventListener("click", () => handleCollect(true));

  // Ctrl+Enter 触发
  document.getElementById("message").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handlePrimaryAction();
    }
  });

  // 历史搜索：输入即过滤（关键词匹配消息内容或平台名）
  document.getElementById("history-search").addEventListener("input", (e) => {
    historyQuery = e.target.value.trim().toLowerCase();
    refreshHistoryView();
  });

  // 清空历史
  document.getElementById("clear-history").addEventListener("click", async () => {
    if (confirm("确定清空所有发送历史？")) {
      await chrome.storage.local.set({ [HISTORY_KEY]: [] });
      historyCache = [];
      refreshHistoryView();
    }
  });
}

// ============ 单平台发送 ============

// 向单个平台发送。返回结果对象（含 platformKey，供失败后手动重试用）。
async function sendToOnePlatform(p, message) {
  let isOpen = !!p.tab;
  const mode = isOpen ? getTabMode(p.tab.id) : "open";
  const manualSend = !!(PLATFORMS[p.key] && PLATFORMS[p.key].manualSend);

  // 已打开的平台：先验证缓存的 tab 是否仍存在（可能已被关闭/ID 失效），
  // 失效则降级为"打开新标签页发送"，避免 "No tab with id" 报错。
  if (isOpen) {
    try {
      await chrome.tabs.get(p.tab.id);
    } catch {
      console.warn(`[Multi Chat] ${p.name} 的标签页已失效，改为新开标签页发送`);
      isOpen = false;
    }
  }

  try {
    console.log(`[Multi Chat] 发送到: ${p.name} (isOpen=${isOpen}, mode=${mode}, manualSend=${manualSend})`);

    let response;

    if (!isOpen) {
      // 未打开：先新建标签页打开平台，再发送
      response = await chrome.runtime.sendMessage({
        action: "openAndSend",
        message: message,
        platform: p.key,
        openUrl: p.newChatUrl,
        manualSend: manualSend
      });
    } else if (mode === "new") {
      // 已打开 + 新对话：跳转到新对话页面再发送
      response = await chrome.runtime.sendMessage({
        action: "navigateAndSend",
        tabId: p.tab.id,
        message: message,
        platform: p.key,
        newChatUrl: p.newChatUrl,
        manualSend: manualSend
      });
    } else {
      // 已打开 + 继续对话：直接发送
      response = await chrome.runtime.sendMessage({
        action: "sendToTab",
        tabId: p.tab.id,
        message: message,
        platform: p.key,
        manualSend: manualSend
      });
    }

    console.log(`[Multi Chat] 响应:`, response);

    const success = !!(response && response.success);
    // 成功 → 解除限制；因额度受限失败（响应带 limitedUntil）→ 记录限制时间
    if (success) {
      setPlatformLimit(p.key, null);
    } else if (response && response.limitedUntil) {
      setPlatformLimit(p.key, response.limitedUntil);
    }

    return {
      platform: p.name,
      platformKey: p.key,
      mode: mode,
      success: success,
      manualSend: !!(response && response.manualSend),
      error: response?.error || ((!response || !response.success) ? "未收到成功响应" : null)
    };
  } catch (err) {
    console.error(`[Multi Chat] 发送异常:`, err);
    return {
      platform: p.name,
      platformKey: p.key,
      mode: mode,
      success: false,
      error: err.message || "通信失败"
    };
  }
}

// ============ 发送消息 ============

async function sendMessage() {
  const messageEl = document.getElementById("message");
  const sendBtn = document.getElementById("send-btn");
  const message = messageEl.value.trim();

  if (!message) {
    showToast("请输入消息内容", "error");
    return;
  }

  const checkboxes = document.querySelectorAll("#tab-list input[type='checkbox']:checked");
  const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));

  if (selectedIndices.length === 0) {
    showToast("请至少选择一个目标", "error");
    return;
  }

  sendBtn.disabled = true;
  const total = selectedIndices.length;
  let completed = 0;
  sendBtn.textContent = `发送中 (0/${total})`;

  // 并行处理所有选中的目标：一次性打开/发送，而不是逐个等待
  const tasks = selectedIndices.map(async (index) => {
    const p = platformList[index];
    const result = await sendToOnePlatform(p, message);
    // 每完成一个任务，更新进度显示
    completed++;
    sendBtn.textContent = `发送中 (${completed}/${total})`;
    return result;
  });

  // 等待所有任务完成（并行执行）
  const results = await Promise.all(tasks);

  sendBtn.disabled = false;
  sendBtn.textContent = "发送";

  // 发送后刷新列表：新打开的平台变"已打开"，受限平台按新排序下移
  await detectPlatforms();

  // 保存到历史
  const historyItem = {
    id: Date.now(),
    time: new Date().toLocaleString("zh-CN"),
    message: message,
    results: results
  };

  await saveToHistory(historyItem);

  // 滚动历史列表到顶部（最新消息）
  document.getElementById("history-list").scrollTop = 0;

  // 显示结果
  const successCount = results.filter(r => r.success).length;

  if (successCount === total) {
    showToast(`全部发送成功 (${total}/${total})`, "success");
  } else {
    showToast(`${successCount}/${total} 成功`, successCount > 0 ? "success" : "error");
  }

  // 清空输入框
  messageEl.value = "";
  messageEl.focus();
}

// ============ 收集回答 ============

// 手动收集：点「收集」按钮触发。对当前勾选平台抓取最新回答并聚合下载。
// 与发送解耦——发送完等答案出来后随时点，不需要发送前决定收集。
// retryFailed=true：对比上次下载结果，只收集上次「失败/未收到」的平台（补收失败）。
async function handleCollect(retryFailed) {
  const collectBtn = document.getElementById("collect-btn");
  const failedBtn = document.getElementById("collect-failed-btn");
  const messageEl = document.getElementById("message");

  const checkboxes = document.querySelectorAll("#tab-list input[type='checkbox']:checked");
  let selected = Array.from(checkboxes)
    .map(cb => platformList[parseInt(cb.dataset.index)])
    .filter(Boolean);

  if (!selected.length) {
    showToast("请至少勾选一个平台", "error");
    return;
  }

  let mergeInfo = null; // 补收时携带上次全文与要覆盖的文件名
  if (retryFailed) {
    const last = await getLastFailedKeys();
    if (last === null) {
      showToast("今天还没有收集记录，请先点「收集」做一次全新收集", "error");
      return;
    }
    if (!last.failed.size) {
      showToast("上次收集全部成功，无需补收", "success");
      return;
    }
    selected = selected.filter(p => last.failed.has(p.key));
    if (!selected.length) {
      showToast("勾选的平台里没有上次失败的项", "error");
      return;
    }
    mergeInfo = { prevText: last.prevText };
  }

  // 收集不依赖发送，输入框可能已清空——用输入框现有内容作为问题标注，没有则占位。
  const message = messageEl.value.trim() || "（手动收集，无对应发送内容）";

  const activeBtn = retryFailed ? failedBtn : collectBtn;
  const label = retryFailed ? "补收" : "📥 收集";
  collectBtn.disabled = true;
  failedBtn.disabled = true;
  try {
    const collected = await collectAnswers(selected, message, activeBtn, mergeInfo);
    const where = mergeInfo ? "已追加到上次结果并存为新文件（Downloads/kiro）" : "已下载到 Downloads/kiro";
    showToast(`已收集 ${collected.count} 份回答，${where}`, collected.count > 0 ? "success" : "error");
  } catch (err) {
    console.error("[Multi Chat] 收集失败:", err);
    showToast(`收集失败：${err.message || "未知错误"}`, "error");
  } finally {
    collectBtn.disabled = false;
    failedBtn.disabled = false;
    activeBtn.textContent = label;
  }
}

// 读取「上次收集」的成败，判定补收目标。
// 数据源 = 最新一次收集产出的聚合文本（与 ~/Downloads/kiro 里那份 .txt 内容一致；
// 扩展读不了本地文件字节，所以用写文件时一并存进 storage 的同一份 text）。
// 判定完全基于文本里的「调试信息」段：
//   - 「时间: <ISO>」必须是今天，否则视为过期（今天首次打开保护）
//   - 「[尝试收集]」里每行 `- 名称 (key): OK|失败|空回答` → 只有 OK 记成功，其余算失败
// 返回:
//   null                                  → 没有可用的今天记录（含首次打开）
//   { failed, prevText }  → failed=需补收的 key 集合；prevText=上次全文（补收时追加于其后）
async function getLastFailedKeys() {
  let text;
  try {
    const { latestCollected } = await chrome.storage.local.get("latestCollected");
    text = latestCollected && latestCollected.text;
  } catch (err) {
    console.error("[Multi Chat] 读取上次收集结果失败:", err);
    return null;
  }
  if (!text) return null;

  const parsed = parseCollectDebug(text);
  if (!parsed || !parsed.time || !isSameLocalDay(parsed.time, Date.now())) return null; // 非今天 → 过期
  return { failed: parsed.failed, prevText: text };
}

// 解析聚合文本的「调试信息」段，抽出收集时间与失败平台 key 集合。
// 文件可能含多段（原始收集 + 若干次「补收」追加），以「最新一段」为准：
//   - 时间取最后一个 "时间: <ISO>"（补收追加在末尾）
//   - 每个平台以最后一次出现的状态为准（后写覆盖先写），只有 OK 记成功。
// 返回 { time: string|null, failed: Set<key> }。
function parseCollectDebug(text) {
  // 最后一个时间
  const times = [...text.matchAll(/时间:\s*(\S+)/g)];
  const time = times.length ? times[times.length - 1][1] : null;

  // 每个 key 的最后状态（按出现顺序覆盖）
  const statusByKey = new Map();
  const lineRe = /^-\s+.+?\(([^)]+)\):\s*(\S+)/gm;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    statusByKey.set(m[1].trim(), m[2].trim());
  }
  const failed = new Set();
  for (const [key, status] of statusByKey) {
    if (status !== "OK") failed.add(key);
  }
  return { time: time, failed };
}

// 两个时间戳是否落在同一「本地自然日」。isoOrMs 可为 ISO 字符串或毫秒数。
function isSameLocalDay(isoOrMs, nowMs) {
  const a = new Date(isoOrMs);
  const b = new Date(nowMs);
  if (isNaN(a)) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// 收集勾选平台本轮回答，聚合成一份文本（含调试段）下载 + 写入 storage，供终端侧（Kiro）总结。
// 手动触发：只对「已勾选 + 支持收集 + 已打开」的平台发起收集；其余记入调试段的[跳过收集]。
// selected：勾选的平台对象数组。btn：收集按钮（显示进度）。
// mergeInfo：补收时传 { prevText }——把本次结果追加到上次全文末尾，写成新文件（不覆盖原文件）；null=全新收集。
// 返回 { count, text }：count=成功抓到的份数，text=聚合文本。
async function collectAnswers(selected, message, btn, mergeInfo) {
  // 先把所有勾选平台分类，记录被跳过的原因（用于调试段），再挑出真正要收集的目标。
  const skipped = [];  // { platform, reason }
  const targets = [];
  for (const p of selected) {
    if (!p.tab) { skipped.push({ platform: p.name, reason: "未打开标签页" }); continue; }
    if (!COLLECT_SUPPORTED.includes(p.key)) { skipped.push({ platform: p.name, reason: "平台不支持收集（无 ANSWER_ADAPTERS 适配器）" }); continue; }
    targets.push(p);
  }

  if (!targets.length) {
    // 没有可收集的平台：仍写入一份带调试信息的说明，避免用户以为卡住
    const text = buildCollectedText(message, [], skipped, selected.length);
    await persistCollected(message, text, 0);
    downloadText(text);
    return { count: 0, text: text };
  }

  btn.textContent = `收集中 (0/${targets.length})`;
  let done = 0;

  const collectTasks = targets.map(async (p) => {
    const t0 = Date.now();
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "collectFromTab",
        tabId: p.tab.id,
        platform: p.key
      });
      done++;
      btn.textContent = `收集中 (${done}/${targets.length})`;
      const answer = resp && resp.answer ? resp.answer : "";
      return {
        platform: p.name,
        key: p.key,
        tabUrl: p.tab.url || "",
        success: !!(resp && resp.success),
        answer: answer,
        chars: answer.length,
        ms: Date.now() - t0,
        error: resp?.error || null
      };
    } catch (err) {
      done++;
      btn.textContent = `收集中 (${done}/${targets.length})`;
      return { platform: p.name, key: p.key, tabUrl: p.tab.url || "", success: false, answer: "", chars: 0, ms: Date.now() - t0, error: err.message || "通信失败" };
    }
  });

  const answers = await Promise.all(collectTasks);
  const ok = answers.filter(a => a.success && a.answer);

  // 补收：把本次结果追加到上次全文末尾（保留原内容不动），写成新文件（不覆盖原文件）。
  // 全新收集：另起一份完整文本，存新文件。
  const text = mergeInfo && mergeInfo.prevText
    ? appendCollectedText(mergeInfo.prevText, answers, skipped)
    : buildCollectedText(message, answers, skipped, selected.length);

  // 落地1（稳）：写入 chrome.storage.local，不受下载设置/焦点/filename 限制，一定成功。
  await persistCollected(message, text, ok.length);

  // 落地2（便捷）：下载成文件到 kiro/。始终新建（uniquify），不覆盖原文件。
  downloadText(text);

  return { count: ok.length, text: text };
}

// 补收追加：在上次全文 prevText 之后追加一段「补收」结果（原内容原样保留，不改动）。
// answers：本次补收各平台结果。skipped：本次被跳过的平台。
// 追加段自带时间与 [尝试收集] 明细，格式与主调试段一致，便于下次 parseCollectDebug 读取最新时间与成败。
function appendCollectedText(prevText, answers, skipped) {
  const okCount = answers.filter(a => a.success && a.answer).length;
  const seg = [`\n\n\n========== 补收 ==========`];
  for (const a of answers) {
    const content = a.success && a.answer ? a.answer : `（未收集到：${a.error || "无回答"}）`;
    seg.push(`\n=== ${a.platform} ===\n${content}`);
  }
  seg.push(`\n\n===== 调试信息 =====`);
  seg.push(`时间: ${new Date().toISOString()}`);
  seg.push(`本次补收: 发起 ${answers.length} · 成功 ${okCount}`);
  if (answers.length) {
    seg.push(`\n[尝试收集]`);
    for (const a of answers) {
      const status = a.success && a.answer ? "OK" : (a.success ? "空回答" : "失败");
      seg.push(`- ${a.platform} (${a.key}): ${status} · ${a.chars} 字 · ${a.ms}ms${a.error ? ` · 错误: ${a.error}` : ""}`);
    }
  }
  if (skipped && skipped.length) {
    seg.push(`\n[跳过收集]`);
    for (const s of skipped) seg.push(`- ${s.platform}: ${s.reason}`);
  }
  return prevText.replace(/\s+$/, "") + seg.join("\n");
}

// 拼装聚合文本：问题 + 各平台回答 + 末尾「调试信息」段。
// answers：尝试收集的平台结果（含 success/chars/ms/error/tabUrl）。
// skipped：勾选但未发起收集的平台及原因。selectedCount：本次勾选总数。
function buildCollectedText(message, answers, skipped, selectedCount) {
  const parts = [`【问题】\n${message}\n`];
  for (const a of answers) {
    parts.push(`\n=== ${a.platform} ===\n${a.success && a.answer ? a.answer : `（未收集到：${a.error || "无回答"}）`}`);
  }

  // 调试段：方便排查"勾了 N 个却只收到几份"。区分"不支持/发送失败"(skipped) 与"尝试收集"的结果。
  const okCount = answers.filter(a => a.success && a.answer).length;
  const dbg = [`\n\n===== 调试信息 =====`];
  dbg.push(`时间: ${new Date().toISOString()}`);
  dbg.push(`勾选平台: ${selectedCount} · 发起收集: ${answers.length} · 收集成功: ${okCount}`);
  if (answers.length) {
    dbg.push(`\n[尝试收集]`);
    for (const a of answers) {
      const status = a.success && a.answer ? "OK" : (a.success ? "空回答" : "失败");
      dbg.push(`- ${a.platform} (${a.key}): ${status} · ${a.chars} 字 · ${a.ms}ms${a.error ? ` · 错误: ${a.error}` : ""}`);
    }
  }
  if (skipped.length) {
    dbg.push(`\n[跳过收集]`);
    for (const s of skipped) dbg.push(`- ${s.platform}: ${s.reason}`);
  }
  parts.push(dbg.join("\n"));
  return parts.join("\n");
}

// 写入 chrome.storage.local。text 与下载的 .txt 内容一致；「补收」靠解析其调试段判定成败。
async function persistCollected(message, text, count) {
  try {
    await chrome.storage.local.set({
      latestCollected: { time: new Date().toISOString(), message: message, text: text, count: count }
    });
  } catch (err) {
    console.error("[Multi Chat] 写入 storage 失败:", err);
  }
}

// 把文本下载成 .txt 到下载目录的 kiro/ 子文件夹（始终新建带时间戳文件，不覆盖）。
// 委托 background（service worker）发起下载：sidepanel 页面上下文调用
// chrome.downloads.download 会忽略 filename（落到 Downloads 根目录、名为"下载.txt"），
// 由 service worker 发起才能让 filename + kiro/ 子目录生效。
// 用 data: URL（中文先 UTF-8 再 base64；SW 里无 URL.createObjectURL）。
function downloadText(text) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const dataUrl = `data:text/plain;charset=utf-8;base64,${b64}`;
    chrome.runtime.sendMessage({
      action: "downloadAnswers",
      dataUrl: dataUrl,
      filename: `kiro/multichat-answers-${stamp}.txt`  // 相对下载目录 → Downloads/kiro/
    }).then(resp => {
      if (!resp || !resp.success) {
        console.error("[Multi Chat] 下载回答文件失败:", resp && resp.error);
      }
    }).catch(err => console.error("[Multi Chat] 下载回答文件失败:", err));
  } catch (err) {
    console.error("[Multi Chat] 下载回答文件失败:", err);
  }
}

// ============ 模式切换 & 搜索历史 ============

// 切换群发/搜索模式，更新 UI 文案并重渲染平台列表（搜索模式灰掉不支持的平台）
function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;

  document.querySelectorAll(".mode-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  const messageEl = document.getElementById("message");
  const sendBtn = document.getElementById("send-btn");
  if (mode === "search") {
    messageEl.placeholder = "输入关键词，在选中平台里搜索历史对话…";
    sendBtn.textContent = "搜索";
  } else {
    messageEl.placeholder = "输入要发送的消息...";
    sendBtn.textContent = "发送";
  }

  // 重渲染平台列表以应用/取消"不支持搜索"的灰态
  renderPlatformList(document.getElementById("tab-list"));
  updateTargetCount();
}

// 主按钮分派：按当前模式走群发或搜索
function handlePrimaryAction() {
  if (currentMode === "search") {
    searchHistory();
  } else {
    sendMessage();
  }
}

// 向单个平台发起历史搜索。已打开→直接搜；未打开→先开标签页再搜。
async function searchOnePlatform(p, keyword) {
  let isOpen = !!p.tab;
  if (isOpen) {
    try {
      await chrome.tabs.get(p.tab.id);
    } catch {
      isOpen = false; // 标签页已失效，降级为新开
    }
  }

  try {
    const response = isOpen
      ? await chrome.runtime.sendMessage({
          action: "searchInTab", tabId: p.tab.id, keyword, platform: p.key
        })
      : await chrome.runtime.sendMessage({
          action: "openAndSearch", keyword, platform: p.key, openUrl: p.newChatUrl
        });

    return {
      platform: p.name,
      platformKey: p.key,
      success: !!(response && response.success),
      error: response?.error || ((!response || !response.success) ? "未收到成功响应" : null)
    };
  } catch (err) {
    return { platform: p.name, platformKey: p.key, success: false, error: err.message || "通信失败" };
  }
}

// 搜索历史：把关键词群发到选中平台，各平台打开自己的搜索框并填入。
async function searchHistory() {
  const messageEl = document.getElementById("message");
  const sendBtn = document.getElementById("send-btn");
  const keyword = messageEl.value.trim();

  if (!keyword) {
    showToast("请输入搜索关键词", "error");
    return;
  }

  const checkboxes = document.querySelectorAll("#tab-list input[type='checkbox']:checked");
  const indices = Array.from(checkboxes)
    .map(cb => parseInt(cb.dataset.index))
    .filter(i => SEARCH_SUPPORTED.includes(platformList[i].key)); // 只搜支持的平台

  if (indices.length === 0) {
    showToast("请至少选择一个支持搜索的平台", "error");
    return;
  }

  sendBtn.disabled = true;
  const total = indices.length;
  let completed = 0;
  sendBtn.textContent = `搜索中 (0/${total})`;

  const tasks = indices.map(async (index) => {
    const result = await searchOnePlatform(platformList[index], keyword);
    completed++;
    sendBtn.textContent = `搜索中 (${completed}/${total})`;
    return result;
  });

  const results = await Promise.all(tasks);

  sendBtn.disabled = false;
  sendBtn.textContent = "搜索";
  await detectPlatforms();

  // 存入历史（kind=search，复用发送历史的渲染与重试）
  await saveToHistory({
    id: Date.now(),
    kind: "search",
    time: new Date().toLocaleString("zh-CN"),
    message: keyword,
    results: results
  });
  document.getElementById("history-list").scrollTop = 0;

  const successCount = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success);
  if (successCount === total) {
    showToast(`已在 ${total} 个平台打开搜索`, "success");
  } else {
    const detail = failed.map(f => `${f.platform}: ${f.error}`).join("；");
    showToast(`${successCount}/${total} 成功。${detail}`, successCount > 0 ? "success" : "error");
  }
}

// ============ 历史记录 ============

async function loadHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  historyCache = data[HISTORY_KEY] || [];
  refreshHistoryView();
}

// 按当前搜索关键词过滤缓存并渲染。关键词匹配消息内容或平台名（大小写不敏感）。
function refreshHistoryView() {
  if (!historyQuery) {
    renderHistory(historyCache);
    return;
  }
  const q = historyQuery;
  const filtered = historyCache.filter(item =>
    item.message.toLowerCase().includes(q) ||
    item.results.some(r => (r.platform || "").toLowerCase().includes(q))
  );
  renderHistory(filtered, historyCache.length > 0 && filtered.length === 0);
}

async function saveToHistory(item) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = data[HISTORY_KEY] || [];

  history.unshift(item);

  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }

  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  historyCache = history;
  refreshHistoryView();
}

function renderHistory(history, noMatch = false) {
  const container = document.getElementById("history-list");

  if (history.length === 0) {
    container.innerHTML = `<div class="empty">${noMatch ? "没有匹配的记录" : "暂无发送记录"}</div>`;
    return;
  }

  container.innerHTML = history.map(item => {
    const isSearch = item.kind === "search";
    const kindBadge = isSearch ? `<span class="msg-kind">🔍 搜索</span>` : "";
    const retryText = isSearch ? "↻ 重搜" : "↻ 重试";
    return `
    <div class="history-item" data-id="${item.id}">
      <div class="msg-time">${kindBadge}${item.time}</div>
      <div class="msg-content">${escapeHtml(item.message)}</div>
      <div class="msg-targets">
        ${item.results.map((r, ri) => {
          const label = `${r.success ? '✓' : '✗'} ${r.platform}${r.mode === 'new' ? '(新)' : r.mode === 'open' ? '(打开)' : ''}${r.manualSend ? ' (已填入，请手动回车)' : ''}${r.error ? ': ' + r.error : ''}`;
          if (r.success) {
            return `<span class="msg-target success" title="${r.error || ''}">${label}</span>`;
          }
          // 失败项：渲染为可点击的重试按钮
          return `<span class="msg-target fail retryable" title="点击重试 · ${r.error || ''}"
                        data-retry-id="${item.id}" data-retry-index="${ri}">
                    ${label} <span class="retry-icon">${retryText}</span>
                  </span>`;
        }).join("")}
      </div>
    </div>
  `}).join("");

  // 重试按钮：点击重新发送该失败的平台
  container.querySelectorAll(".msg-target.retryable").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // 不触发"点击历史项重新填入"
      const historyId = parseInt(el.dataset.retryId);
      const resultIndex = parseInt(el.dataset.retryIndex);
      retryOne(historyId, resultIndex, el);
    });
  });

  // 点击历史项可重新填入
  container.querySelectorAll(".history-item").forEach(el => {
    el.addEventListener("click", () => {
      const id = parseInt(el.dataset.id);
      const item = history.find(h => h.id === id);
      if (item) {
        switchMode(item.kind === "search" ? "search" : "send");
        document.getElementById("message").value = item.message;
        document.getElementById("message").focus();
      }
    });
  });
}

// 重试单个失败的平台
async function retryOne(historyId, resultIndex, btnEl) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = data[HISTORY_KEY] || [];
  const item = history.find(h => h.id === historyId);
  if (!item) return;

  const failed = item.results[resultIndex];
  if (!failed) return;

  // 根据 platformKey 找到当前的平台项（可能标签页状态已变，重新检测）
  await detectPlatforms();
  const p = platformList.find(pl => pl.key === failed.platformKey);
  if (!p) {
    showToast(`找不到平台 ${failed.platform}`, "error");
    return;
  }

  // 按钮进入"重试中"状态
  btnEl.classList.add("retrying");
  const iconEl = btnEl.querySelector(".retry-icon");
  const isSearch = item.kind === "search";
  if (iconEl) iconEl.textContent = isSearch ? "搜索中…" : "发送中…";

  // 按记录类型分派：搜索历史走搜索，普通消息走发送
  const result = isSearch
    ? await searchOnePlatform(p, item.message)
    : await sendToOnePlatform(p, item.message);

  // 更新该条历史记录的对应结果
  item.results[resultIndex] = result;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  historyCache = history;

  // 重新渲染历史并提示
  refreshHistoryView();
  if (result.success) {
    showToast(`${result.platform} ${isSearch ? "重搜成功" : "重试成功"}`, "success");
  } else {
    showToast(`${result.platform} ${isSearch ? "重搜" : "重试"}失败: ${result.error}`, "error");
  }
}

// ============ 工具函数 ============

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// 把限制解除时间戳格式化为 HH:MM（跨天则加"明日"）
function formatResetTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hhmm = d.toTimeString().slice(0, 5);
  const now = new Date();
  const crossDay = d.getDate() !== now.getDate() || d.getMonth() !== now.getMonth();
  return crossDay ? `明日 ${hhmm}` : hhmm;
}

function showToast(text, type = "") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.className = `toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}
