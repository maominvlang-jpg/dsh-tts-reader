# dsh-tts-reader

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一个**「朗读」按钮**：一键把当前会话里 AI 的最新回复念给你听，浏览器本地合成，不上传任何内容。

> English: [README.en.md](README.en.md)

## 功能

- **按会话朗读**：在哪个会话点按钮，读的就是那个会话的最新一条回复；历史会话也能读（自动从磁盘日志回溯）
- **切换会话自动停止**：朗读中切到别的会话，声音立刻停
- **内容净化**：代码块正文照念（歌词不会漏），但图标 emoji、装饰标点（《》～【】等）、图片、网址、markdown 标记一律不念；`，。！？` 等只作停顿
- **音色选择器**：下拉切换系统所有可用语音（中文优先），选择自动记住
- **🎤 唱歌**：输入歌词和风格，调用 Suno 兼容 API 生成带人声伴奏的完整歌曲并直接播放（需自备 API Key，见下）
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

### 🎤 唱歌功能（可选，需 API Key）

1. 在 [sunoapi.org](https://sunoapi.org)（或任何 Suno 兼容中转站）注册并充值，复制 **API Key**
2. 点输入框下方的「🎤 唱歌」→ 在面板里粘贴 Key → 保存
3. 填**风格**（如 `慵懒民谣 女声 温暖`），**歌词**可留空让 AI 自动写词 → 点「生成歌曲」
4. 约 1~2 分钟后自动播放；一次生成两个版本

说明：API Key 保存在你本机 `~/.dsh/dsh-tts-reader/config.json`（权限 600），不进 git、不上传；歌曲由第三方服务生成，按其定价计费（通常每首几毛到两元）。朗读和唱歌互斥——一个响，另一个自动停；切换会话两者都会停止。

### 想要更好听的音色

浏览器只能用系统已装的语音。推荐在 macOS 上下载高品质中文语音：

`系统设置 → 辅助功能 → 朗读内容 → 管理语音 → 中文`，勾选 **Siri 声音** 或 **婷婷（高级版）**，下载完成后在插件下拉框里选中即可。

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
