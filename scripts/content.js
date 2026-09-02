// Content Script - 负责在各聊天平台页面中注入消息并触发发送
// 核心策略：使用 clipboard API + execCommand 模拟真实粘贴，比直接 innerHTML 更可靠

// 防止重复注入：manifest 自动注入 + background 手动注入可能导致同一页面注入多次，
// 重复执行会因 const 重复声明而整个脚本报错。用全局守卫确保只初始化一次。
if (window.__multiChatContentLoaded) {
  console.log("[Multi Chat] Content script 已存在，跳过重复注入");
} else {
  window.__multiChatContentLoaded = true;

// 各平台的 DOM 选择器和操作方式
const PLATFORM_ADAPTERS = {
  chatgpt: {
    getInput() {
      // ChatGPT 2024+ 使用 ProseMirror contenteditable div, id="prompt-textarea"
      return document.querySelector("#prompt-textarea") ||
             document.querySelector('div[contenteditable="true"][data-id]') ||
             document.querySelector('textarea[data-id="root"]');
    },
    getSendButton() {
      return document.querySelector('[data-testid="send-button"]') ||
             document.querySelector('button[aria-label*="Send"]');
    }
  },

  claude: {
    getInput() {
      // Claude 使用 ProseMirror，选择器要精确避免选到文件上传区域
      return document.querySelector('.ProseMirror[contenteditable="true"]') ||
             document.querySelector('div[data-placeholder][contenteditable="true"]') ||
             document.querySelector('fieldset .ProseMirror');
    },
    getSendButton() {
      return document.querySelector('button[data-testid="send-button"]') ||
             document.querySelector('button[aria-label*="Send message" i]') ||
             document.querySelector('button[aria-label="Send" i]');
    }
  },

  gemini: {
    getInput() {
      return document.querySelector('.ql-editor[contenteditable="true"]') ||
             document.querySelector('div[contenteditable="true"][aria-label*="prompt"]') ||
             document.querySelector('rich-textarea [contenteditable="true"]');
    },
    getSendButton() {
      return document.querySelector('button[aria-label*="Send"]') ||
             document.querySelector('button.send-button') ||
             document.querySelector('button[mattooltip*="Send"]');
    }
  },

  tongyi: {
    getInput() {
      return document.querySelector('textarea[class*="chat"]') ||
             document.querySelector('#china-main textarea') ||
             document.querySelector('textarea');
    },
    getSendButton() {
      return document.querySelector('button[class*="send"]') ||
             document.querySelector('[class*="operateBtn"]') ||
             document.querySelector('[data-testid*="send"]');
    }
  },

  deepseek: {
    getInput() {
      return document.querySelector('#chat-input') ||
             document.querySelector('textarea[class*="chat"]') ||
             document.querySelector('textarea');
    },
    getSendButton() {
      return document.querySelector('div[role="button"][class*="send"]') ||
             document.querySelector('button[class*="send"]') ||
             document.querySelector('[data-testid="send-button"]');
    }
  },

  kimi: {
    getInput() {
      return document.querySelector('[contenteditable="true"]') ||
             document.querySelector('textarea') ||
             document.querySelector('#editor');
    },
    getSendButton() {
      return document.querySelector('[data-testid*="send"]') ||
             document.querySelector('button[class*="send"]') ||
             document.querySelector('[class*="send"][role="button"]');
    }
  },

  zai: {
    getInput() {
      return document.querySelector('.ProseMirror[contenteditable="true"]') ||
             document.querySelector('div[data-placeholder][contenteditable="true"]') ||
             document.querySelector('[contenteditable="true"]') ||
             document.querySelector('textarea');
    },
    getSendButton() {
      return document.querySelector('button[data-testid="send-button"]') ||
             document.querySelector('button[aria-label*="Send"]') ||
             document.querySelector('button[aria-label*="send"]') ||
             document.querySelector('button[class*="send"]');
    }
  }
};

// ============ 核心发送逻辑 ============

async function fillAndSend(platform, message, onSent) {
  const adapter = PLATFORM_ADAPTERS[platform];
  if (!adapter) throw new Error("不支持的平台: " + platform);

  const input = adapter.getInput();
  if (!input) throw new Error("找不到输入框，请确认页面已完全加载");

  // 聚焦输入框
  input.focus();
  await wait(100);

  // 清空现有内容
  await clearInput(input);
  await wait(50);

  // 填入消息 - 使用模拟输入的方式
  await simulateTyping(input, message);
  await wait(400);

  // 验证内容确实进入了输入框（Z.AI 等编辑器状态同步可能滞后）
  await waitForInputFilled(input, message, 1500);

  // 点击发送按钮，随后确认消息真的发出去了（输入框清空或消息出现在对话区）。
  const sent = await clickSend(adapter, input, message, onSent);
  if (!sent) {
    throw new Error("发送按钮未找到或不可点击");
  }

  return true;
}

// 等待输入框内容真正填入（轮询验证，避免在内容同步前就触发发送）
async function waitForInputFilled(input, message, timeout) {
  const startTime = Date.now();
  const expected = message.trim().slice(0, 20); // 只比对前 20 字符，够判断了

  while (Date.now() - startTime < timeout) {
    const current = (input.tagName === "TEXTAREA" || input.tagName === "INPUT")
      ? input.value
      : input.textContent;

    if (current && current.trim().includes(expected)) {
      return true;
    }
    await wait(150);
  }
  // 超时也继续（不阻断），交给 clickSend 的按钮状态判断兜底
  console.warn("[Multi Chat] 输入框内容验证超时，继续尝试发送");
  return false;
}

// 清空输入框
async function clearInput(input) {
  input.focus();

  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    // 对 textarea 使用 select all + delete
    input.select();
    document.execCommand("delete");
  } else {
    // contenteditable: select all then delete
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete");
  }
}

// 模拟输入 - 使用 execCommand insertText（最接近真实用户输入）
async function simulateTyping(input, message) {
  input.focus();

  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    // 对于 textarea，使用 native value setter + input 事件
    // 这是让 React controlled input 识别变化的最可靠方式
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(input, message);
    } else {
      input.value = message;
    }

    // 触发完整的事件序列
    input.dispatchEvent(new Event("focus", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

  } else {
    // contenteditable: 使用 execCommand('insertText') - 这是最接近用户输入的方式
    // 它会被 ProseMirror/Slate 等编辑器正确捕获
    const inserted = document.execCommand("insertText", false, message);

    if (!inserted) {
      // fallback: 使用 InputEvent
      input.textContent = message;
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: message
      }));
    }

    // 额外触发事件确保框架感知
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// 读取输入框当前文本
function getInputText(input) {
  return (input.tagName === "TEXTAREA" || input.tagName === "INPUT")
    ? input.value
    : input.textContent;
}

// 发送成功的判定：满足任一即视为成功
//   1) 输入框被清空（大多数平台发送后会清空输入框）
//   2) 刚发送的消息文本出现在输入框之外（即出现在了对话区）
// 轮询检测，返回 true = 确认成功；false = 超时仍未确认（可能未发出）。
async function confirmSent(adapter, message, timeout) {
  const snippet = message.trim().slice(0, 30); // 用前 30 字符作为匹配特征
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    // 页面可能重渲染/跳转，重新取输入框引用；取不到视为已提交
    let input;
    try {
      input = adapter.getInput();
    } catch {
      return true;
    }
    if (!input) return true; // 输入框不在了（页面跳转/重渲染），说明已提交

    const inputText = getInputText(input);
    const inputEmpty = !inputText || inputText.trim() === "";

    // 信号 1：输入框已清空
    if (inputEmpty) return true;

    // 信号 2：消息已出现在对话区（输入框之外）
    if (snippet && messageAppearedOutsideInput(input, snippet)) return true;

    await wait(150);
  }
  return false;
}

// 检查刚发送的消息文本是否出现在输入框之外（对话区）。
// 发送前该文本只在输入框内；发送后会出现在消息气泡里。
function messageAppearedOutsideInput(input, snippet) {
  const bodyText = document.body.innerText || "";
  // 出现次数：如果输入框里还留着（未清空），body 里至少 1 次
  // 只要对话区也出现了，总次数 >= 2；或输入框已不含该文本但 body 含有
  const inputText = getInputText(input) || "";
  const inInput = inputText.includes(snippet);
  const occurrences = countOccurrences(bodyText, snippet);

  if (!inInput && occurrences >= 1) return true;      // 输入框已无该文本，但页面上有 → 在对话区
  if (inInput && occurrences >= 2) return true;        // 输入框有 + 对话区也有
  return false;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// 点击发送按钮。onSent 在确认发送成功时调用。
async function clickSend(adapter, input, message, onSent) {
  // 先等一下让框架处理输入
  await wait(200);

  let triggered = false;

  // 轮询等待发送按钮变为可用（最多 2 秒），可用则点击
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const btn = adapter.getSendButton();
    if (btn) {
      const isDisabled = btn.disabled ||
                         btn.getAttribute("aria-disabled") === "true" ||
                         btn.classList.contains("disabled");
      if (!isDisabled) {
        btn.click();
        triggered = true;
        break;
      }
    }
    await wait(150);
  }

  // 按钮不可用则回退到 Enter 键
  if (!triggered) {
    console.warn("[Multi Chat] 发送按钮不可用，回退到 Enter 键");
    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(enterEvent);
    await wait(50);
    input.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true
    }));
  }

  // 确认真的发出去了：输入框被清空 或 消息已出现在对话区。最多等 4 秒。
  const confirmed = await confirmSent(adapter, message, 4000);
  if (!confirmed) {
    // 输入框仍有内容且对话区没出现该消息——发送很可能没成功（Z.AI 偶发的情况）
    throw new Error("发送未确认：输入框未清空且对话区未出现该消息");
  }

  if (typeof onSent === "function") onSent();
  return true;
}

// ============ 工具函数 ============

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 消息监听 ============

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    sendResponse({ success: true, platform: detectCurrentPlatform() });
    return false;
  }

  if (request.action === "checkInputReady") {
    // 检查输入框是否已就绪（用于新对话模式的轮询）
    const platform = request.platform;
    const adapter = PLATFORM_ADAPTERS[platform];
    if (!adapter) {
      sendResponse({ ready: false, error: "不支持的平台" });
      return false;
    }

    const input = adapter.getInput();
    const ready = !!(input && (input.offsetParent !== null || input.offsetHeight > 0));
    console.log(`[Multi Chat] checkInputReady: platform=${platform}, ready=${ready}`);
    sendResponse({ ready: ready });
    return false;
  }

  if (request.action === "fillAndSend") {
    const platform = request.platform;
    const message = request.message;

    console.log(`[Multi Chat] 收到发送指令: platform=${platform}, message="${message.substring(0, 30)}..."`);

    // 保证 sendResponse 只被调用一次
    let responded = false;
    const respondSuccess = () => {
      if (responded) return;
      responded = true;
      console.log(`[Multi Chat] 发送动作已触发: ${platform}`);
      sendResponse({ success: true });
    };

    fillAndSend(platform, message, respondSuccess)
      .then(() => {
        // 正常情况下发送动作触发时已经通过 onSent 回传成功；这里兜底
        respondSuccess();
      })
      .catch(err => {
        if (responded) return; // 已经回传过成功（发送动作已触发），忽略后续异常
        responded = true;
        console.error(`[Multi Chat] 发送失败: ${platform}`, err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // 异步响应
  }
});

// 检测当前页面平台
function detectCurrentPlatform() {
  const url = window.location.href;
  for (const [key, adapter] of Object.entries(PLATFORM_ADAPTERS)) {
    // 简单匹配
    if (url.includes(key) || 
        (key === "chatgpt" && (url.includes("chatgpt.com") || url.includes("chat.openai.com"))) ||
        (key === "tongyi" && url.includes("tongyi.aliyun.com")) ||
        (key === "deepseek" && url.includes("chat.deepseek.com")) ||
        (key === "kimi" && (url.includes("kimi.moonshot.cn") || url.includes("kimi.com"))) ||
        (key === "zai" && url.includes("chat.z.ai"))) {
      return key;
    }
  }
  return null;
}

console.log("[Multi Chat] Content script loaded:", window.location.href);

} // end 防止重复注入守卫
