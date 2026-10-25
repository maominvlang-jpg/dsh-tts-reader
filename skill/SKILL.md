---
name: dsh-tts-reader
version: 1.0.0
description: "朗读与 AI 唱歌：用 macOS 原生 say 把文本/文件/最新回复朗读出来（可选音色、可停止、可持久化音色偏好）；用本机免费离线 ACE-Step 引擎（mlx-serve）或 Suno 兼容云端 API 生成带人声的完整歌曲。当用户要求「念给我听 / 朗读 / 读出来 / TTS / 语音播报」或「唱首歌 / 生成歌曲 / AI 音乐 / 写歌」时使用。全部本机处理，不上传内容。"
metadata:
  requires:
    bins: ["say", "node"]
---

# dsh-tts-reader（朗读 + AI 唱歌）

把「念出来」和「唱出来」变成 Agent 可直接执行的能力。所有处理都在本机完成：

- **朗读**：macOS 原生 `say`，离线，不联网
- **唱歌**：本机 mlx-serve（ACE-Step，免费无限次）或自备 Key 的 Suno 兼容中转 API
- 配置与产物目录：`~/.dsh/dsh-tts-reader/`（`config.json` 存配置与 API Key，`songs/` 存歌曲，`history.json` 存历史）

脚本位置：本 skill 目录下 `scripts/tts.mjs` 和 `scripts/song.mjs`（用 `node <skill目录>/scripts/xxx.mjs` 调用，下文简写为 `tts.mjs` / `song.mjs`）。

## 一、朗读（tts.mjs）

### 列音色

```bash
node tts.mjs voices --lang zh    # 中文优先排列，* 标记当前默认
```

高品质中文声音推荐（macOS 需先在 `系统设置 → 辅助功能 → 朗读内容 → 管理语音` 下载）：`Tiantian (Enhanced)`（田田增强版）、`Tingting`（婷婷）、Siri 系列。默认自动选择顺序：记住的音色 > Siri/增强版 > Tiantian > Tingting > 任意中文。

### 朗读文本

```bash
node tts.mjs speak "要朗读的文字"                    # 直接念
node tts.mjs speak --voice Tingting --rate 200 "…"  # 指定音色与语速（wpm，默认 200）
node tts.mjs speak --file /path/to/article.md       # 朗读整个文件
cat some.txt | node tts.mjs speak                   # 管道输入
node tts.mjs speak --dry-run "…"                    # 先预览净化后的文本，不真念
```

- **前台阻塞直到念完**，所以长文朗读时不要再并发执行其它 speak
- 自动净化：代码块只去围栏保留正文（歌词不丢）、链接只留文字、网址/markdown 记号/装饰符号（《》～【】☆★等）不念
- 记住音色：`node tts.mjs set-voice "Tiantian (Enhanced)"`

### 停止朗读

```bash
node tts.mjs stop
```

用户说「别念了 / 停」时立即执行，不要等念完。

### 朗读「AI 的最新回复」

用户说「把你刚才说的念给我听」时：不需要回溯会话日志，**你本轮回复的正文就是素材**。直接把它净化后交给 `speak`（先 `--dry-run` 确认净化效果再真念）。若用户指的是历史某轮，让用户提供那段文字，或朗读会话导出文件。

## 二、唱歌（song.mjs）

### 前置检查（本机模式）

```bash
node song.mjs health
```

在线返回 `本机引擎在线`。离线时按提示启动（一次性安装，见 references/setup.md）：

```bash
mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight
```

### 生成歌曲

```bash
# 本机（默认 provider，免费、离线、M 系芯片约 4s 出 30s）
node song.mjs gen --style "轻快的流行民谣，吉他与口琴" --lyrics "歌词…"
node song.mjs gen --style "电子舞曲" --title "晨跑"                # 纯音乐：歌词留空即可
node song.mjs gen --style "…" --lyrics-file /path/to/lyrics.txt --duration 120
```

- 时长会**按歌词量自动延长**（约 2.4s/字 + 前奏），保证字不被吞；`--duration` 只是下限
- 散文化歌词自动切成一行一句；带 `[verse]`/`[chorus]` 结构标签的歌词原样保留
- 本机生成是**同步阻塞**的（几十秒到几分钟），完成后打印 wav 路径和 `afplay` 试听命令
- 本机一次只能跑一个任务，忙时稍等重试

### 云端模式（可选，Suno 兼容中转）

```bash
node song.mjs config set apiKey "sk-xxxx"          # 配置 Key（只存本机，600 权限）
node song.mjs gen --provider cloud --style "…" --lyrics "…" --title "歌名"
```

云端默认轮询 5 分钟，就绪后打印所有音轨 URL。

### 历史与配置

```bash
node song.mjs history --tail 10    # 本地歌曲附带 afplay 试听命令
node song.mjs config show          # apiKey 打码显示
node song.mjs config set localDuration 120
node song.mjs config set provider local    # 或 cloud
```

## 三、行为准则

1. 生成歌曲前**先 health 检查**；引擎离线时给出启动命令，不要反复重试
2. 朗读用 `--dry-run` 预览净化结果（尤其用户给的是 markdown/歌词时），确认无误再真念
3. 用户在朗读/生成中要求停止：朗读用 `tts.mjs stop`；本机生成无法中断引擎，如实告知并等它完成
4. API Key 只写入本机 `config.json`，绝不回显完整值、绝不写进会话外的任何地方
5. 用户没给歌词又想要纯音乐：`gen --style "…"` 歌词留空即可，不必追问
6. 详细安装（mlx-serve 引擎、模型下载、Cloudflare 内网穿透等）见 [references/setup.md](references/setup.md)
