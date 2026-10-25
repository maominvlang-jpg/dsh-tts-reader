# dsh-tts-reader

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一个**「朗读」按钮**：一键把当前会话里 AI 的最新回复念给你听，浏览器本地合成，不上传任何内容。

> English: [README.en.md](README.en.md)

## 功能

- **按会话朗读**：在哪个会话点按钮，读的就是那个会话的最新一条回复；历史会话也能读（自动从磁盘日志回溯）
- **切换会话自动停止**：朗读中切到别的会话，声音立刻停
- **内容净化**：代码块正文照念（歌词不会漏），但图标 emoji、装饰标点（《》～【】等）、图片、网址、markdown 标记一律不念；`，。！？` 等只作停顿
- **音色选择器**：下拉切换系统所有可用语音（中文优先），选择自动记住
- **🎤 唱歌（本机免费）**：基于开源音乐模型 ACE-Step 1.5（MLX 版，Apple 芯片原生），输入歌词和风格，本机生成带人声伴奏的完整歌曲——免费、无限次、离线、数据不出本机
- **🎤 唱歌（云端可选）**：也可切换到任意 Suno 兼容中转 API（需自备 Key）
- **多语言界面**：按钮文案跟随 DSH 界面语言（中/英）

## 安装

```sh
dsh plugin --profile desktop add github:maominvlang-jpg/dsh-tts-reader
```

> 换成你自己的 profile 名（`dsh profile list` 可查；桌面版默认是 `desktop`）。
> 仓库里就是可直接运行的 ESM 源码，没有构建步骤，不会触发构建授权。

装完**重启一次 DSH**，然后在页面里按 **Ctrl+Shift-RA（macOS: Cmd+Shift+R）硬刷新** —— DSH 的插件资源带强缓存，普通刷新可能还在跑旧代码。

## 使用

1. 打开任意会话，输入框下方找到 **「朗读最新回复」** 按钮（🔊 圆角胶囊）
2. 点一下开始朗读，再点一下停止
3. 旁边下拉框可换音色，选完立即生效
4. 如果当前会话还没有回复、或找不到该会话，按钮旁会提示"改读最新一条"

### 🎤 唱歌功能

面板顶部可选模式：

**💻 本机（免费，推荐）** —— 无需任何账号：
1. 安装引擎（一次性）：
   ```sh
   brew tap ddalcu/mlx-serve https://github.com/ddalcu/mlx-serve
   brew trust ddalcu/mlx-serve && brew install mlx-serve
   ```
2. 下载模型（一次性，约 6.6GB）到 `~/.mlx-serve/models/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit/`（可在 HuggingFace 或 hf-mirror.com 获取）
3. 启动引擎：`mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight`（建议做成 LaunchAgent 开机自启）
4. 面板选「💻 本机」→ 填风格 → 填歌词（留空 = 纯音乐）→ 生成。M 系列芯片约 4 秒可生成 30 秒歌曲

**☁️ 云端（Suno 中转）**：在 [sunoapi.org](https://sunoapi.org) 等兼容中转站注册充值 → 面板粘贴 API Key → 填风格和歌词 → 生成。按其定价计费

说明：本机模式完全离线，歌曲缓存在 `~/.dsh/dsh-tts-reader/songs/`；朗读和唱歌互斥，切换会话两者都停。

### 想要更好听的音色

浏览器只能用系统已装的语音。推荐在 macOS 上下载高品质中文语音：

`系统设置 → 辅助功能 → 朗读内容 → 管理语音 → 中文`，勾选 **Siri 声音** 或 **婷婷（高级版）**，下载完成后在插件下拉框里选中即可。

## 🧠 Skill 版（Agent 直接驱动）

仓库还附带一个**可安装的 DSH skill**（[skill/](skill) 目录），让 Agent 直接完成朗读与唱歌，无需点按钮：

```sh
# 安装（复制到用户级 skill 目录，所有会话可用）
mkdir -p ~/.dsh/skills && cp -R skill ~/.dsh/skills/dsh-tts-reader
```

安装后直接对 Agent 说「念给我听」「唱首歌」即可触发。能力一览：

- **朗读**：macOS 原生 `say`（离线），可念任意文本/文件/管道输入；`--dry-run` 预览净化结果、`stop` 随时停止、音色偏好持久化
- **唱歌**：`song.mjs gen --style "…" --lyrics "…"`，与插件共用同一本机引擎、同一配置（`~/.dsh/dsh-tts-reader/`）与歌曲缓存；歌词自动分行、时长按字数自动延长
- 详见 [skill/SKILL.md](skill/SKILL.md)；引擎安装见 [skill/references/setup.md](skill/references/setup.md)

插件版与 skill 版可共存，互不冲突。

## 工作原理

```
Host 半边 (index.js)                     Client 半边 (client.js)
──────────────────────                   ──────────────────────
监听 session/event 事件流                 注册「朗读」按钮 + 音色下拉框
  └ 缓存每个会话的最新回复                  到 conversation.composer.dock
未命中时按需回溯：                          点击时取当前会话 id，
  内存会话 → 磁盘日志回放                   fetch /dsh-tts/latest?session=<id>
  (sessionQuery.readSession)               用 Web Speech API 本地朗读
GET /dsh-tts/latest ──────────────────────▶
```

- 朗读完全在**你的浏览器本地**完成，回复文本只经由本机回环地址（127.0.0.1），不经过任何外部服务
- 自带 Chrome 长文本 ~15s 断音修复（pause/resume 保活）
- 子代理会话（agent teams 的 teammate）的回复不进入缓存

## 兼容性

- 兼容 DSH `0.1.5-rc.x` / `0.1.7-rc.x` / `0.2.0-rc.x` 各版本线
- 刻意**不声明**任何 `@deepseek-ai/dsh-*` 的 peerDependencies（宿主服务全部防御式访问），不会被版本兼容闸门跳过
- 只依赖浏览器标准 API：`speechSynthesis`（Chrome / Edge / Safari 均支持）

## 卸载

```sh
dsh plugin --profile desktop remove dsh-tts-reader
```

## License

[MIT](LICENSE)
