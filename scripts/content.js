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
      // 新版千问(www.qianwen.com)用 Slate 编辑器；旧版用 textarea
      return document.querySelector('[data-slate-editor="true"]') ||
             document.querySelector('div[contenteditable="true"][role="textbox"]') ||
             document.querySelector('textarea[class*="chat"]') ||
             document.querySelector('#china-main textarea') ||
             document.querySelector('[contenteditable="true"]') ||
             document.querySelector('textarea');
    },
    getSendButton() {
      return document.querySelector('[data-testid*="send"]') ||
             document.querySelector('button[aria-label*="发送"]') ||
             document.querySelector('button[class*="send"]') ||
             document.querySelector('[class*="operateBtn"]');
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
  },

  doubao: {
    getInput() {
      return document.querySelector('textarea[data-testid="chat_input_input"]') ||
             document.querySelector('textarea') ||
             document.querySelector('[contenteditable="true"]');
    },
    getSendButton() {
      return document.querySelector('[data-testid="chat_input_send_button"]') ||
             document.querySelector('button[aria-label*="发送"]') ||
             document.querySelector('button[class*="send"]') ||
             document.querySelector('[class*="send"][role="button"]');
    }
  },

  grok: {
    getInput() {
      // Grok 2025 UI 用 Tiptap/ProseMirror contenteditable；旧版为 textarea
      return document.querySelector('.ProseMirror[contenteditable="true"]') ||
             document.querySelector('div[contenteditable="true"][role="textbox"]') ||
             document.querySelector('textarea[aria-label*="Grok" i]') ||
             document.querySelector('textarea') ||
             document.querySelector('[contenteditable="true"]');
    },
    getSendButton() {
      return document.querySelector('button[type="submit"]') ||
             document.querySelector('button[aria-label*="Submit" i]') ||
             document.querySelector('button[aria-label*="Send" i]') ||
             document.querySelector('button[class*="send"]');
    }
  }
};

// ============ 搜索历史对话适配 ============
// 方案 a：打开各平台自带的"搜索历史对话"入口，并把关键词填进去，结果显示在各自页面。
// 与发送逻辑完全独立。每个平台需要：
//   openTrigger(): 点开搜索入口（侧栏搜索按钮），返回是否点到了；点不到时上层走快捷键兜底
//   getSearchInput(): 返回搜索框元素（搜索面板弹出后才存在）
//   shortcut: 打不开入口时的快捷键兜底（{ key, ctrl, shift, meta }）
//
// ponytail: 这些选择器依赖各平台登录态下的 SPA 结构，无法在本环境真机验证，改版即失效。
// 每个平台都留了多重 fallback + 快捷键兜底 + 通用兜底（找页面上带"搜索/search"的输入框）。
// 真机失效时，抓取该平台搜索面板的 HTML 来校准对应选择器即可。
const SEARCH_ADAPTERS = {
  gemini: {
    // Gemini 侧栏"搜索"入口
    openTrigger() {
      return clickFirst([
        'button[aria-label*="搜索" i]',
        'button[aria-label*="Search" i]',
        'button[data-test-id*="search" i]',
        '[role="button"][aria-label*="Search" i]'
      ]);
    },
    getSearchInput() {
      return document.querySelector('input[aria-label*="搜索" i]') ||
             document.querySelector('input[aria-label*="Search" i]') ||
             document.querySelector('input[type="search"]') ||
             document.querySelector('input[placeholder*="搜索" i]') ||
             document.querySelector('input[placeholder*="Search" i]');
    },
    // 社区扩展显示 Gemini 搜索会话为 Ctrl+Shift+K（非官方，作兜底）
    shortcut: { key: "k", ctrl: true, shift: true }
  },

  tongyi: {
    // 新版 www.qianwen.com：搜索按钮是图标按钮，内含 <svg><use href="#qwpcicon-search2">。
    // 真机确认图标名 qwpcicon-search2；搜索框为 input[placeholder="搜索"]。
    // ponytail: 靠 svg use 的图标名（语义化，较稳）；换图标名即失效，届时重抓 use href 替换。
    openTrigger() {
      // 找图标名含 search 的 <use>（普通 href 或 xlink:href），遍历比 CSS 命名空间选择器稳
      const use = [...document.querySelectorAll("use")].find(u => {
        const h = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
        return /search/i.test(h);
      });
      // 从 use 往上找最近的可点击祖先（button / role=button），点它
      let node = use;
      while (node) {
        if (node.tagName === "BUTTON" || node.getAttribute?.("role") === "button") {
          node.click();
          return true;
        }
        node = node.parentElement;
      }
      // 兜底：直接点 use 所在 svg 的父元素
      const svgParent = use && use.closest("svg") && use.closest("svg").parentElement;
      if (svgParent) { svgParent.click(); return true; }
      return false;
    },
    getSearchInput() {
      return document.querySelector('input[placeholder="搜索"]') ||
             document.querySelector('input[placeholder*="搜索"]') ||
             document.querySelector('input[type="search"]') ||
             document.querySelector('input[placeholder*="Search" i]');
    }
  },

  deepseek: {
    // DeepSeek 侧栏搜索按钮是纯图标 div.ds-button，无 aria-label / 无稳定 class，
    // 只能靠放大镜 svg 的 path 特征定位（真机确认 d 以 "M11.748" 开头）。
    // ponytail: path 前缀是当前图标的形状指纹，DeepSeek 换图标即失效；
    // 兜底策略：找不到指纹时，点顶部工具栏（top<80）里第一个带 svg 的 ds-button。
    // 升级路径：失效时重新抓 path d 前缀替换 SEARCH_ICON_PREFIX。
    openTrigger() {
      const SEARCH_ICON_PREFIX = "M11.748";
      const btns = [...document.querySelectorAll(".ds-button")].filter(
        el => el.offsetParent !== null || el.offsetHeight > 0
      );
      // 1) 按放大镜图标 path 指纹精确匹配
      let target = btns.find(el => {
        const p = el.querySelector("path");
        return p && (p.getAttribute("d") || "").startsWith(SEARCH_ICON_PREFIX);
      });
      // 2) 兜底：顶部工具栏最靠左上角、带 svg 图标的按钮
      if (!target) {
        target = btns
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.top < 80 && el.querySelector("svg");
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      }
      if (target) { target.click(); return true; }
      return false;
    },
    getSearchInput() {
      // 真机确认：input[type=text] placeholder="搜索对话内容..."
      return document.querySelector('input[placeholder*="搜索对话"]') ||
             document.querySelector('input[placeholder*="搜索"]') ||
             document.querySelector('input[type="search"]') ||
             document.querySelector('input[placeholder*="Search" i]');
    }
  },

  grok: {
    // Grok 搜索历史入口（ChatGPT 风格，多为 Ctrl+K 命令面板）
    openTrigger() {
      return clickFirst([
        'button[aria-label*="Search" i]',
        'button[aria-label*="搜索" i]',
        '[data-testid*="search" i]'
      ]);
    },
    getSearchInput() {
      return document.querySelector('input[type="search"]') ||
             document.querySelector('input[placeholder*="Search" i]') ||
             document.querySelector('input[placeholder*="搜索" i]') ||
             document.querySelector('[role="dialog"] input[type="text"]');
    },
    shortcut: { key: "k", ctrl: true }
  }
};

// 点击选择器列表里第一个存在且可见的元素，返回是否点到
function clickFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && (el.offsetParent !== null || el.offsetHeight > 0)) {
      el.click();
      return true;
    }
  }
  return false;
}

// 派发快捷键（用于打不开搜索入口时的兜底）
function pressShortcut(sc) {
  const opts = {
    key: sc.key,
    code: "Key" + sc.key.toUpperCase(),
    ctrlKey: !!sc.ctrl,
    shiftKey: !!sc.shift,
    metaKey: !!sc.meta,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window
  };
  for (const t of [document.activeElement || document.body, document]) {
    t.dispatchEvent(new KeyboardEvent("keydown", opts));
    t.dispatchEvent(new KeyboardEvent("keyup", opts));
  }
}

// 在搜索框里填入关键词（复用发送逻辑的 simulateTyping / execCommand 策略）。
async function fillSearchInput(input, keyword) {
  input.focus();
  await wait(80);
  await clearInput(input);
  await wait(50);
  await simulateTyping(input, keyword);
  await wait(200);
}

// 打开某平台的搜索历史入口并填入关键词。成功返回 true。
// 流程：点搜索入口 →（点不到则按快捷键）→ 轮询等待搜索框出现 → 填词。
async function openSearchAndFill(platform, keyword) {
  const sa = SEARCH_ADAPTERS[platform];
  if (!sa) throw new Error("该平台暂不支持搜索历史: " + platform);

  // 1) 尝试点开搜索入口
  let opened = false;
  try { opened = sa.openTrigger(); } catch (e) { /* ignore */ }

  // 2) 点不到就用快捷键兜底（若该平台配了快捷键）
  if (!opened && sa.shortcut) {
    pressShortcut(sa.shortcut);
  }

  // 3) 轮询等待搜索框出现（最多 4 秒），出现即填词
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const input = sa.getSearchInput();
    if (input && (input.offsetParent !== null || input.offsetHeight > 0)) {
      await fillSearchInput(input, keyword);
      return true;
    }
    // 首轮没出现，若还没试过快捷键则再补一次
    await wait(200);
  }
  throw new Error("未找到搜索框，可能平台改版或需登录");
}


// ============ 核心发送逻辑 ============

// 通用：检测"停止生成"按钮（上一条还在生成时，发送按钮会变成停止按钮）。
// 各平台停止按钮多以 aria-label / data-testid 含 stop 标识，或按钮内含方形停止图标。
function getStopButton() {
  return document.querySelector('button[data-testid="stop-button"]') ||
         document.querySelector('button[aria-label*="Stop" i]') ||
         document.querySelector('button[aria-label*="停止"]') ||
         document.querySelector('button[aria-label*="stop generating" i]') ||
         null;
}

// 如果页面正在生成（存在停止按钮），先停止，等待恢复到可发送状态。
async function stopIfGenerating() {
  const stopBtn = getStopButton();
  if (!stopBtn) return;

  console.log("[Multi Chat] 检测到正在生成，先点击停止");
  stopBtn.click();

  // 等待停止按钮消失（恢复为发送状态），最多 3 秒
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!getStopButton()) return;
    await wait(200);
  }
  console.warn("[Multi Chat] 停止后未在预期时间内恢复，继续尝试发送");
}

// 检测"额度用完/需要升级"等阻止发送的提示。
// 只在输入框附近区域检测，避免误伤用户消息内容里的相同词汇。
// 返回 { notice, limitedUntil } （表示不可发送）或 null。
//   notice: 展示给用户的提示文本
//   limitedUntil: 限制解除的时间戳（ms）；解析不到重置时间时用兜底（now + 3h）
function detectBlockingNotice(input) {
  if (!input) return null;

  // 完全无法发送文本的关键词（额度耗尽类）
  const blockingPatterns = [
    /免费额度.*用完/,
    /额度.*(已用完|用尽|耗尽)/,
    /消息.*(已用完|达到上限)/,
    /聊天已暂停/,
    /额度.*(将在|将于).*(重置|恢复)/,
    /out of (free )?(quota|credits|messages)/i,
    /usage limit reached/i,
    /you'?ve reached your.*(message |usage )?limit/i,
    /rate limit(ed)?/i
  ];

  // 强阻止信号：命中这些说明整个聊天被暂停（纯文本也发不出），
  // 即使同区域出现"纯文本仍可用"字样也不豁免。ChatGPT 会同时显示
  // "聊天已暂停…重置" + "请发起新的纯文本聊天"，但实际是发不出去的。
  const hardBlockPatterns = [
    /聊天已暂停/,
    /额度.*(将在|将于).*(重置|恢复)/,
    /chat.*paused/i,
    /usage limit reached/i
  ];

  // "文本仍可用"的豁免词——命中这些说明只是部分功能受限（如 ChatGPT 的文件/图像/数据分析
  // 受限，但仍可纯文本聊天），此时不应阻止发送。
  const allowPatterns = [
    /仅使用文本/,
    /继续.*文本聊天/,
    /纯文本聊天/,
    /可以继续/,
    /仍可.*(使用|聊天|发送)/,
    /continue.*(with )?text/i,
    /text (chat|only)/i,
    /still (use|chat|send)/i
  ];

  // 从输入框向上找最多 5 层祖先，检查其中的可见文本
  let node = input;
  for (let i = 0; i < 5 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    if (node.offsetParent === null && node.offsetHeight === 0) continue;
    const text = (node.innerText || "").slice(0, 400);

    // 先看是否命中"完全不可发送"关键词
    const hitBlocking = blockingPatterns.find(re => re.test(text));
    if (hitBlocking) {
      const hardBlocked = hardBlockPatterns.some(re => re.test(text));
      // 仅当不是强阻止、且同区域提示"文本仍可用"时，才豁免（部分功能受限）
      if (!hardBlocked && allowPatterns.some(re => re.test(text))) {
        console.log("[Multi Chat] 检测到额度提示，但文本仍可用，继续发送");
        return null;
      }
      const line = text.split("\n").find(l => hitBlocking.test(l)) || text.slice(0, 40);
      return {
        notice: line.trim().slice(0, 60),
        limitedUntil: parseResetTime(text)
      };
    }
  }
  return null;
}

// 从限制提示文本里解析"额度重置时间"，返回时间戳（ms）。
// 支持：绝对时间 "14:51 重置" / "resets at 3:00 PM"；相对时间 "2 小时后" / "in 2 hours"。
// 解析不到时兜底为 now + 3 小时（ChatGPT 滚动窗口通常 3-4 小时）。
// ponytail: 只覆盖已知的两种时间格式；出现新格式时走兜底，不会误判为不受限。
function parseResetTime(text) {
  const now = Date.now();
  const FALLBACK = now + 3 * 60 * 60 * 1000;

  // 1) 绝对时间 HH:MM（如 "14:51 重置"、"resets at 14:51"）
  const hm = text.match(/(\d{1,2}):(\d{2})/);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h <= 23 && m <= 59) {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      // 若该时刻已过（今天更早），说明是明天重置
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }

  // 2) 相对小时数（如 "2 小时后"、"in 2 hours"、"3 hrs"）
  const rel = text.match(/(\d+)\s*(小时|hours?|hrs?)/i);
  if (rel) {
    const hours = parseInt(rel[1], 10);
    if (hours > 0 && hours <= 168) return now + hours * 60 * 60 * 1000;
  }

  return FALLBACK;
}

async function fillAndSend(platform, message, onSent, manualSend) {
  const adapter = PLATFORM_ADAPTERS[platform];
  if (!adapter) throw new Error("不支持的平台: " + platform);

  const input = adapter.getInput();
  if (!input) throw new Error("找不到输入框，请确认页面已完全加载");

  // 检测额度用完/需要升级等阻止发送的提示，命中则直接停止，不浪费时间尝试
  const blocking = detectBlockingNotice(input);
  if (blocking) {
    const err = new Error("无法发送：" + blocking.notice);
    err.limitedUntil = blocking.limitedUntil; // 带回限制解除时间，供排序用
    throw err;
  }

  // 若上一条还在生成中（发送按钮变成了停止按钮），先停止再发送
  await stopIfGenerating();

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

  // manualSend 平台（如通义千问，严格校验 isTrusted，程序化发送无法触发）：
  // 只填入内容，提示用户手动按回车发送。
  if (manualSend) {
    console.log(`[Multi Chat] ${platform} 需手动发送，已填入内容`);
    if (typeof onSent === "function") onSent({ manualSend: true });
    return true;
  }

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
    // 优先用 execCommand insertText 模拟真实键盘输入——Vue(v-model)/React 都能可靠识别，
    // 比 native value setter + 普通 input 事件更稳（千问等 Vue 应用靠这个才认为"有内容"、启用发送按钮）
    input.focus();
    // 先选中已有内容以便替换（clearInput 已清空，这里是保险）
    input.select();
    const inserted = document.execCommand("insertText", false, message);

    if (!inserted || !input.value || !input.value.includes(message.slice(0, 10))) {
      // fallback：native value setter + 完整 InputEvent（带 inputType/data，框架更易识别）
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

      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: message
      }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

  } else {
    // contenteditable 富文本编辑器（Slate/ProseMirror 等）
    // Slate 只认 beforeinput 事件流来更新其内部 state，纯 execCommand 只改 DOM 不改 state，
    // 会导致"看起来有字但编辑器认为是空的、无法发送"。所以先派发 beforeinput。
    input.focus();
    // 光标移到内容末尾
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* ignore */ }

    // 1) 派发 beforeinput（Slate 监听此事件更新 state）
    let beforeinputHandled = false;
    try {
      const bi = new InputEvent("beforeinput", {
        inputType: "insertText",
        data: message,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      beforeinputHandled = !input.dispatchEvent(bi); // 被 preventDefault 说明编辑器接管了
    } catch (e) { /* 某些环境不支持构造 InputEvent，忽略 */ }

    // 2) execCommand 兜底（对 ProseMirror 等有效；Slate 若已处理 beforeinput 则这里可能重复，
    //    但重复内容比没内容好，且多数编辑器会去重/以 state 为准）
    if (!beforeinputHandled) {
      const inserted = document.execCommand("insertText", false, message);
      if (!inserted) {
        input.textContent = message;
      }
    }

    // 3) 派发 input 事件通知框架
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: message
    }));
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

// 模拟按下 Enter 发送。强化版：确保光标在编辑器内，向多个目标派发完整事件序列。
function pressEnter(input) {
  // 1) 确保光标落在编辑器内容末尾（Slate 的回车处理依赖有效 selection）
  try {
    input.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false); // 折叠到末尾
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {
    console.warn("[Multi Chat] 设置光标失败", e);
  }

  const opts = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    charCode: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window
  };

  // 2) 向多个目标派发（不同 Slate 实现把 keydown 处理器挂在不同层级）
  const targets = [];
  if (document.activeElement && document.activeElement !== document.body) {
    targets.push(document.activeElement);
  }
  if (!targets.includes(input)) targets.push(input);
  targets.push(document);

  for (const t of targets) {
    t.dispatchEvent(new KeyboardEvent("keydown", opts));
    t.dispatchEvent(new KeyboardEvent("keypress", opts));
    t.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // 3) 额外尝试 beforeinput insertParagraph（Slate 处理回车的标准 inputType）
  try {
    input.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertParagraph",
      bubbles: true,
      cancelable: true,
      composed: true
    }));
  } catch (e) { /* 某些浏览器不支持构造，忽略 */ }
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
    pressEnter(input);
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
    const manualSend = !!request.manualSend;

    console.log(`[Multi Chat] 收到发送指令: platform=${platform}, manualSend=${manualSend}, message="${message.substring(0, 30)}..."`);

    // 保证 sendResponse 只被调用一次
    let responded = false;
    const respondSuccess = (extra) => {
      if (responded) return;
      responded = true;
      console.log(`[Multi Chat] 发送动作已触发: ${platform}`);
      sendResponse(Object.assign({ success: true }, extra || {}));
    };

    fillAndSend(platform, message, respondSuccess, manualSend)
      .then(() => {
        // 正常情况下发送动作触发时已经通过 onSent 回传成功；这里兜底
        respondSuccess();
      })
      .catch(err => {
        if (responded) return; // 已经回传过成功（发送动作已触发），忽略后续异常
        responded = true;
        console.error(`[Multi Chat] 发送失败: ${platform}`, err);
        sendResponse({ success: false, error: err.message, limitedUntil: err.limitedUntil });
      });

    return true; // 异步响应
  }

  if (request.action === "checkSearchReady") {
    // 检查该平台是否支持搜索（有适配即视为 content script 已就绪，可执行搜索）
    const supported = !!SEARCH_ADAPTERS[request.platform];
    sendResponse({ ready: supported });
    return false;
  }

  if (request.action === "openSearch") {
    const platform = request.platform;
    const keyword = request.keyword;
    console.log(`[Multi Chat] 收到搜索指令: platform=${platform}, keyword="${keyword}"`);

    openSearchAndFill(platform, keyword)
      .then(() => sendResponse({ success: true }))
      .catch(err => {
        console.error(`[Multi Chat] 搜索失败: ${platform}`, err);
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
        (key === "tongyi" && (url.includes("tongyi.aliyun.com") || url.includes("tongyi.com") || url.includes("qianwen.com"))) ||
        (key === "deepseek" && url.includes("chat.deepseek.com")) ||
        (key === "kimi" && (url.includes("kimi.moonshot.cn") || url.includes("kimi.com"))) ||
        (key === "zai" && url.includes("chat.z.ai")) ||
        (key === "grok" && url.includes("grok.com")) ||
        (key === "doubao" && url.includes("doubao.com"))) {
      return key;
    }
  }
  return null;
}

console.log("[Multi Chat] Content script loaded:", window.location.href);

} // end 防止重复注入守卫
