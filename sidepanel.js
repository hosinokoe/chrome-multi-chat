// Side Panel 主逻辑

const PLATFORMS = {
  chatgpt: { name: "ChatGPT", patterns: ["chatgpt.com", "chat.openai.com"], newChatUrl: "https://chatgpt.com/" },
  claude: { name: "Claude", patterns: ["claude.ai"], newChatUrl: "https://claude.ai/new" },
  gemini: { name: "Gemini", patterns: ["gemini.google.com"], newChatUrl: "https://gemini.google.com/app" },
  tongyi: { name: "通义千问", patterns: ["tongyi.aliyun.com"], newChatUrl: "https://tongyi.aliyun.com/qianwen/" },
  deepseek: { name: "DeepSeek", patterns: ["chat.deepseek.com"], newChatUrl: "https://chat.deepseek.com/" },
  kimi: { name: "Kimi", patterns: ["kimi.moonshot.cn", "www.kimi.com"], newChatUrl: "https://www.kimi.com/" },
  zai: { name: "Z.AI", patterns: ["chat.z.ai"], newChatUrl: "https://chat.z.ai/" }
};

const HISTORY_KEY = "multiChatHistory";
const MODE_KEY = "multiChatModes";
const THEME_KEY = "multiChatTheme";
const MAX_HISTORY = 100;

// 每个平台的展示项：已打开的带 tab 信息，未打开的 tab 为 null
let platformList = []; // [{ key, name, newChatUrl, tab: {id,title,favIconUrl} | null }]
let tabModes = {}; // { tabId: "new" | "continue" }

document.addEventListener("DOMContentLoaded", async () => {
  await loadTheme();
  await loadModes();
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

    // 未打开的平台：默认不勾选，显示"未打开"标记 + "打开并发送"提示
    const checked = isOpen ? "checked" : "";
    const statusBadge = isOpen
      ? ""
      : `<span class="platform-status-closed">未打开</span>`;

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
    <label class="tab-item ${isOpen ? "" : "tab-item-closed"}">
      <input type="checkbox" data-index="${index}" ${checked}>
      ${iconHtml}
      <span class="tab-title" title="${isOpen ? p.tab.title : p.name}">${p.name}</span>
      ${statusBadge}
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

  // checkbox 变化
  document.getElementById("tab-list").addEventListener("change", (e) => {
    if (e.target.type === "checkbox") {
      updateTargetCount();
    }
  });

  // 发送
  document.getElementById("send-btn").addEventListener("click", sendMessage);

  // Ctrl+Enter 发送
  document.getElementById("message").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  });

  // 清空历史
  document.getElementById("clear-history").addEventListener("click", async () => {
    if (confirm("确定清空所有发送历史？")) {
      await chrome.storage.local.set({ [HISTORY_KEY]: [] });
      renderHistory([]);
    }
  });
}

// ============ 单平台发送 ============

// 向单个平台发送。返回结果对象（含 platformKey，供失败后手动重试用）。
async function sendToOnePlatform(p, message) {
  const isOpen = !!p.tab;
  const mode = isOpen ? getTabMode(p.tab.id) : "open";

  try {
    console.log(`[Multi Chat] 发送到: ${p.name} (isOpen=${isOpen}, mode=${mode})`);

    let response;

    if (!isOpen) {
      // 未打开：先新建标签页打开平台，再发送
      response = await chrome.runtime.sendMessage({
        action: "openAndSend",
        message: message,
        platform: p.key,
        openUrl: p.newChatUrl
      });
    } else if (mode === "new") {
      // 已打开 + 新对话：跳转到新对话页面再发送
      response = await chrome.runtime.sendMessage({
        action: "navigateAndSend",
        tabId: p.tab.id,
        message: message,
        platform: p.key,
        newChatUrl: p.newChatUrl
      });
    } else {
      // 已打开 + 继续对话：直接发送
      response = await chrome.runtime.sendMessage({
        action: "sendToTab",
        tabId: p.tab.id,
        message: message,
        platform: p.key
      });
    }

    console.log(`[Multi Chat] 响应:`, response);

    return {
      platform: p.name,
      platformKey: p.key,
      mode: mode,
      success: response && response.success,
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

  // 有新打开的平台，刷新列表让它们变成"已打开"状态
  const hadClosedTargets = selectedIndices.some(i => !platformList[i].tab);
  if (hadClosedTargets) {
    await detectPlatforms();
  }

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

// ============ 历史记录 ============

async function loadHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = data[HISTORY_KEY] || [];
  renderHistory(history);
}

async function saveToHistory(item) {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  const history = data[HISTORY_KEY] || [];

  history.unshift(item);

  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }

  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  renderHistory(history);
}

function renderHistory(history) {
  const container = document.getElementById("history-list");

  if (history.length === 0) {
    container.innerHTML = `<div class="empty">暂无发送记录</div>`;
    return;
  }

  container.innerHTML = history.map(item => `
    <div class="history-item" data-id="${item.id}">
      <div class="msg-time">${item.time}</div>
      <div class="msg-content">${escapeHtml(item.message)}</div>
      <div class="msg-targets">
        ${item.results.map((r, ri) => {
          const label = `${r.success ? '✓' : '✗'} ${r.platform}${r.mode === 'new' ? '(新)' : r.mode === 'open' ? '(打开)' : ''}${r.error ? ': ' + r.error : ''}`;
          if (r.success) {
            return `<span class="msg-target success" title="${r.error || ''}">${label}</span>`;
          }
          // 失败项：渲染为可点击的重试按钮
          return `<span class="msg-target fail retryable" title="点击重试 · ${r.error || ''}"
                        data-retry-id="${item.id}" data-retry-index="${ri}">
                    ${label} <span class="retry-icon">↻ 重试</span>
                  </span>`;
        }).join("")}
      </div>
    </div>
  `).join("");

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
  const originalIcon = iconEl ? iconEl.textContent : "";
  if (iconEl) iconEl.textContent = "发送中…";

  const result = await sendToOnePlatform(p, item.message);

  // 更新该条历史记录的对应结果
  item.results[resultIndex] = result;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });

  // 重新渲染历史并提示
  renderHistory(history);
  if (result.success) {
    showToast(`${result.platform} 重试成功`, "success");
  } else {
    showToast(`${result.platform} 重试失败: ${result.error}`, "error");
  }
}

// ============ 工具函数 ============

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
