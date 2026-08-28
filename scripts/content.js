// Content Script - 负责在各聊天平台页面中注入消息并触发发送
// 核心策略：使用 clipboard API + execCommand 模拟真实粘贴，比直接 innerHTML 更可靠

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

async function fillAndSend(platform, message) {
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

  // 点击发送按钮
  const sent = await clickSend(adapter, input);
  if (!sent) {
    throw new Error("发送按钮未找到或不可点击");
  }

  return true;
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

// 点击发送按钮
async function clickSend(adapter, input) {
  // 先等一下让框架处理输入
  await wait(300);

  const sendBtn = adapter.getSendButton();

  if (sendBtn) {
    // 检查按钮是否可用
    const isDisabled = sendBtn.disabled ||
                       sendBtn.getAttribute("aria-disabled") === "true" ||
                       sendBtn.classList.contains("disabled");

    if (!isDisabled) {
      sendBtn.click();
      return true;
    }

    // 按钮被禁用，等待一下再试
    await wait(500);
    const retryBtn = adapter.getSendButton();
    if (retryBtn && !retryBtn.disabled && retryBtn.getAttribute("aria-disabled") !== "true") {
      retryBtn.click();
      return true;
    }
  }

  // fallback: 尝试 Enter 键
  const enterEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  });
  input.dispatchEvent(enterEvent);

  // 也触发 keyup
  await wait(50);
  input.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true
  }));

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

    fillAndSend(platform, message)
      .then(() => {
        console.log(`[Multi Chat] 发送成功: ${platform}`);
        sendResponse({ success: true });
      })
      .catch(err => {
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
