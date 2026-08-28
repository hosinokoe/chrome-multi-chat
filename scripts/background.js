// Background Service Worker - 协调通信 + 管理 Side Panel

// 设置侧边栏行为：点击图标打开
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error("[Multi Chat] setPanelBehavior error:", err));

// 监听来自 sidepanel 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "sendToTab") {
    console.log(`[Multi Chat BG] sendToTab: tabId=${request.tabId}, platform=${request.platform}`);
    handleSendToTab(request.tabId, request.message, request.platform)
      .then(result => {
        console.log(`[Multi Chat BG] sendToTab result:`, result);
        sendResponse(result);
      })
      .catch(err => {
        console.error(`[Multi Chat BG] sendToTab error:`, err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "navigateAndSend") {
    console.log(`[Multi Chat BG] navigateAndSend: tabId=${request.tabId}, platform=${request.platform}, url=${request.newChatUrl}`);
    handleNavigateAndSend(request.tabId, request.message, request.platform, request.newChatUrl)
      .then(result => {
        console.log(`[Multi Chat BG] navigateAndSend result:`, result);
        sendResponse(result);
      })
      .catch(err => {
        console.error(`[Multi Chat BG] navigateAndSend error:`, err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "openAndSend") {
    console.log(`[Multi Chat BG] openAndSend: platform=${request.platform}, url=${request.openUrl}`);
    handleOpenAndSend(request.message, request.platform, request.openUrl)
      .then(result => {
        console.log(`[Multi Chat BG] openAndSend result:`, result);
        sendResponse(result);
      })
      .catch(err => {
        console.error(`[Multi Chat BG] openAndSend error:`, err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (request.action === "contentScriptReady") {
    console.log("[Multi Chat BG] Content script ready:", request.url);
  }

  return false;
});

// ============ 继续对话：直接发送 ============

async function handleSendToTab(tabId, message, platform) {
  await ensureContentScriptInjected(tabId);

  const response = await sendMessageToTabWithTimeout(tabId, {
    action: "fillAndSend",
    message: message,
    platform: platform
  }, 10000);

  return response;
}

// ============ 新对话：导航 → 等待加载 → 等输入框 → 发送 ============

async function handleNavigateAndSend(tabId, message, platform, newChatUrl) {
  // 第一步：导航到新对话页面
  console.log(`[Multi Chat BG] Navigating tab ${tabId} to ${newChatUrl}`);
  await chrome.tabs.update(tabId, { url: newChatUrl });

  // 第二步：等待页面加载完成
  await waitForTabLoaded(tabId, 15000);
  console.log(`[Multi Chat BG] Tab ${tabId} loaded`);

  // 额外等待一下，让 SPA 的 JS 渲染完成
  await wait(2000);

  // 第三步：注入 content script
  await injectContentScript(tabId);

  // 第四步：等待输入框就绪（轮询）
  console.log(`[Multi Chat BG] Waiting for input ready on tab ${tabId}`);
  await waitForInputReady(tabId, platform, 10000);

  // 第五步：填入消息并发送
  console.log(`[Multi Chat BG] Sending message on tab ${tabId}`);
  const response = await sendMessageToTabWithTimeout(tabId, {
    action: "fillAndSend",
    message: message,
    platform: platform
  }, 10000);

  return response;
}

// ============ 新建标签页：打开 → 等待加载 → 等输入框 → 发送 ============

async function handleOpenAndSend(message, platform, openUrl) {
  // 第一步：新建标签页（后台打开，不激活以免打断用户）
  console.log(`[Multi Chat BG] Creating new tab: ${openUrl}`);
  const tab = await chrome.tabs.create({ url: openUrl, active: false });
  const tabId = tab.id;

  // 第二步：等待页面加载完成
  await waitForTabLoaded(tabId, 20000);
  console.log(`[Multi Chat BG] New tab ${tabId} loaded`);

  // 短暂等待让 SPA 开始渲染（后续用轮询兜底，不必等太久）
  await wait(800);

  // 第三步：注入 content script
  await injectContentScript(tabId);

  // 第四步：等待输入框就绪（轮询，一就绪立即继续；新开页面给更长超时，可能需要登录）
  console.log(`[Multi Chat BG] Waiting for input ready on new tab ${tabId}`);
  try {
    await waitForInputReady(tabId, platform, 15000);
  } catch (err) {
    // 输入框未就绪，很可能是需要登录
    return { success: false, error: "页面已打开但输入框未就绪（可能需要登录）", tabId: tabId };
  }

  // 第五步：填入消息并发送
  console.log(`[Multi Chat BG] Sending message on new tab ${tabId}`);
  const response = await sendMessageToTabWithTimeout(tabId, {
    action: "fillAndSend",
    message: message,
    platform: platform
  }, 10000);

  return response;
}

// ============ 工具函数 ============

// 等待标签页加载完成
function waitForTabLoaded(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeout);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // 检查是否已经加载完成
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// 等待输入框就绪（通过 content script 轮询）
async function waitForInputReady(tabId, platform, timeout) {
  const startTime = Date.now();
  const interval = 300;

  while (Date.now() - startTime < timeout) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: "checkInputReady",
        platform: platform
      });

      if (response && response.ready) {
        return;
      }
    } catch {
      // content script 可能还没就绪，继续等
    }

    await wait(interval);
  }

  throw new Error("输入框等待超时，页面可能未完全加载");
}

// 注入 content script
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["scripts/content.js"]
    });
    await wait(300);
  } catch (err) {
    throw new Error(`无法注入脚本: ${err.message}`);
  }
}

// 确保目标标签页已注入 content script
async function ensureContentScriptInjected(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (response && response.success) {
      return;
    }
  } catch {
    // ping 失败，需要注入
  }

  await injectContentScript(tabId);
}

// 带超时的 tabs.sendMessage
function sendMessageToTabWithTimeout(tabId, message, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("发送超时，页面可能未响应"));
    }, timeout);

    chrome.tabs.sendMessage(tabId, message)
      .then(response => {
        clearTimeout(timer);
        if (response) {
          resolve(response);
        } else {
          reject(new Error("content script 无响应"));
        }
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
