# Multi Chat Sender

一个 Chrome 扩展，通过右侧常驻侧边栏，一次性向多个在线 AI 聊天平台发送相同的消息，方便横向对比不同模型的回答。

## 功能特性

- 📨 **一键群发** — 在侧边栏输入一条消息，同时发送到多个 AI 聊天平台
- 📌 **常驻侧边栏** — 使用 Chrome Side Panel，发送后面板不消失
- 📜 **历史记录** — 自动保存每次发送的内容、时间、目标平台和成功/失败状态（最多 100 条）
- 🔀 **对话模式** — 每个平台可独立选择「继续当前对话」或「开启新对话」，也支持统一设置
- 🚀 **自动打开** — 对未打开的平台，勾选后发送时会自动新建标签页并发送
- ⌨️ **快捷键** — 支持 Ctrl/Cmd + Enter 快速发送

## 支持的平台

| 平台 | 地址 |
|------|------|
| ChatGPT | chatgpt.com / chat.openai.com |
| Claude | claude.ai |
| Gemini | gemini.google.com |
| 通义千问 | tongyi.aliyun.com |
| DeepSeek | chat.deepseek.com |
| Kimi | kimi.moonshot.cn / www.kimi.com |
| Z.AI | chat.z.ai |

## 安装

1. 下载或克隆本仓库到本地
   ```bash
   git clone https://github.com/hosinokoe/chrome-multi-chat.git
   ```
2. 打开 Chrome，进入 `chrome://extensions/`
3. 打开右上角的「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本项目文件夹
5. 扩展图标会出现在工具栏

## 使用方法

1. 点击工具栏的扩展图标，打开右侧侧边栏
2. 侧边栏会自动列出所有支持的平台，并标注哪些已打开
3. 勾选要发送的目标平台（已打开的默认勾选，未打开的可手动勾选）
4. 为每个已打开的平台选择「继续」或「新对话」模式（可选）
5. 在输入框输入消息，点击「发送」（或按 Ctrl/Cmd + Enter）
6. 发送结果会显示在下方历史列表中

## 项目结构

```
chrome-multi-chat/
├── manifest.json       # 扩展配置（Manifest V3）
├── sidepanel.html      # 侧边栏界面
├── sidepanel.css       # 样式
├── sidepanel.js        # 侧边栏主逻辑
├── scripts/
│   ├── background.js   # Service Worker（消息路由、标签页管理）
│   └── content.js      # Content Script（各平台 DOM 适配）
└── icons/              # 扩展图标
```

## 工作原理

- **sidepanel.js** 负责界面交互，检测已打开的标签页，并向 background 发送指令
- **background.js** 作为协调层，负责注入 content script、打开/导航标签页、转发消息
- **content.js** 注入到各聊天页面，通过平台特定的 DOM 选择器填入消息并触发发送

填入消息时使用 `document.execCommand("insertText")`（针对 ProseMirror 等富文本编辑器）和原生 value setter（针对 textarea），以确保 React/Vue 等框架能正确识别输入变化。

## 已知限制

- **选择器依赖平台 DOM 结构** — 各 AI 平台前端改版后，对应的输入框/发送按钮选择器可能失效，需要更新 `scripts/content.js` 中的适配器
- **需要登录态** — 自动打开未登录的平台时，输入框无法就绪，会提示「可能需要登录」
- **依赖页面完全加载** — SPA 页面渲染较慢时，可能需要调整 `background.js` 中的等待时长

## 贡献

欢迎提 Issue 或 PR，尤其是新平台适配和选择器更新。

## License

MIT
