---
name: dsh-tts-reader
version: 1.2.0
description: "朗读与 AI 唱歌：朗读文本/文件/最新回复（macOS say 离线、edge-tts 在线、F5 零样本声音克隆三种引擎，可选音色与情绪基调、逐句自动情绪、短剧式多角色配音，可停止、可持久化偏好）；用本机免费离线 ACE-Step 引擎（mlx-serve）或 Suno 兼容云端 API 生成带人声的完整歌曲。当用户要求「念给我听 / 朗读 / 读出来 / TTS / 语音播报 / 用我的声音念 / 克隆声音说话 / 给这段配音 / 演一段戏」或「唱首歌 / 生成歌曲 / AI 音乐 / 写歌」时使用。朗读全部本机处理不上传内容（edge 引擎需联网）；唱歌本机离线生成或走云端 API。"
metadata:
  requires:
    bins: ["say", "node"]
---

# dsh-tts-reader（朗读 + AI 唱歌）

把「念出来」和「唱出来」变成 Agent 可直接执行的能力：

- **朗读**：三种引擎自动挑选——F5 零样本声音克隆（注册过音色时优先，像真人）> `edge-tts`（在线、音质自然）> macOS 原生 `say`（完全离线兜底）
- **唱歌**：本机 mlx-serve（ACE-Step，免费无限次）或自备 Key 的 Suno 兼容中转 API
- 配置与产物目录：`~/.dsh/dsh-tts-reader/`（`config.json` 存配置与 API Key，`songs/` 存歌曲，`history.json` 存历史，`voice-clone/` 存克隆音色，`clone-cache/` 存插件预合成缓存）

脚本位置：本 skill 目录下 `scripts/tts.mjs`、`scripts/song.mjs`、`scripts/clone_speak.py`（前两个用 `node <skill目录>/scripts/xxx.mjs` 调用，下文简写为 `tts.mjs` / `song.mjs`；`clone_speak.py` 是 clone 引擎的合成桥，由 tts.mjs 自动调用，不用手动跑）。

## 一、朗读（tts.mjs）

### 引擎与情绪

三引擎，`--engine auto`（默认）自动选择：

- **clone**：F5-TTS-MLX 零样本克隆——**最接近真人的一条路**（像某个真人的音色，还自带真人的起承转合）。venv 与模型就绪后，先 `clone-voice` 注册音色才能用
- **edge**（联网）：微软神经语音 `zh-CN-XiaoxiaoNeural`（晓晓）+ 句内语调弧线，快而有情绪；没注册克隆音色或要快速朗读时用它（当前默认嗓）
- **say**（离线兜底）：macos 原生 `say`，优先 Premium（Yue）> Enhanced（田田）

**克隆音色管理**：
```bash
node tts.mjs clone-voice --name <id> --audio <任意音频> --ref-text "<音频里台词原文>"  # 注册
node tts.mjs voices    # 末行显示 clone 引擎状态与已注册音色
node tts.mjs render --out <x.wav> [--voice <id>] [--mood <m>] [文本或 stdin]  # 合成到文件不播放（插件 Host 用它预渲染）
# 换回晓晓：node tts.mjs set-voice zh-CN-XiaoxiaoNeural --engine edge
```
- 音色名只能小写字母/数字/连字符（1~32 位，首字符是字母或数字）；`--ref-text` 必须与音频内容一字不差，错了就不像
- 参考音频任意格式都行（自动转 24kHz 单声道），10~60 秒、干净无 BGM 效果最好（SenseVoice 可转写台词）。西施素材来自用户提供的台词合集 mp4，切了 0~20.28s 最干净的一段（无 BGM，-70dB 底噪）
- 音色存放在 `~/.dsh/dsh-tts-reader/voice-clone/<name>/`，试听参考音频：`afplay …/ref_24k.wav`
- `render` 预合成限 1500 字（超长自动截断防 CPU 长跑）
- 克隆单句合成约 10~20 秒（v2 加速：euler 采样 + 批量单进程 + 按字数估时；更长的回复边合成边播，第一句好了就念）。长文用克隆偏慢，先提醒主人，或改用 edge/say

**插件按钮/自动朗读也用克隆嗓**（v1.6.0）：Host 收到朗读请求时调 `render` 合成 wav 缓存（`~/.dsh/dsh-tts-reader/clone-cache/`），浏览器播放音频文件；合成中每 2 秒轮询，超时/超长（>400 字）/失败自动回退浏览器语音。重启 DSH + 硬刷新后生效。

**语调弧线（像真人的关键）**：真人说话不是一字一调，而是起音略沉、中段赶一点、句尾按句型收。edge/say 会把句子再切成小句（、，；：）逐小句调 rate/pitch/volume，连起来就是起伏的语调：

- 起句略沉稍慢；承接小句微升、略快（逗号处的延续感）；收尾按句型走——问句 +18Hz 扬起、感叹 +10Hz 提速、省略号 -12Hz 放慢放软、陈述 -6Hz 收住
- 小句间呼吸：顿号 0.14s、逗号 0.2s、分号/冒号 0.28s；段落之间 0.9s 大喘气
- 情绪信号越浓，rate/pitch/volume 摆幅越大（封顶 1.6 倍）；pitch 总范围 -35~+45Hz 防尖叫
- edge **边合成边放**（放这句时合成下一句，stderr 打印「合成中 n/N」），长文第一句很快出声
- clone 引擎**整句**合成：克隆嗓自带真人的起承转合，切碎反而跳调
- 诗行（单换行）之间换口气 0.25s，**空行**才是段落大喘气 0.9s

**情绪标记（「理解感情」的关键）**：关键词打分只是猜，**真正读懂文字感情的是写这段文本的那位**。念诗、念故事、念任何有感情的文字时，把你看懂的情绪直接标进 `speak` 的文本里（**聊天正文不带标记**，标记只活在朗读文本里）：

| 标记 | 效果 |
|---|---|
| `【害羞】【温柔】【生气】` 等（也认 `[happy]`） | 从标记起、**到下一个标记或空行为止**用这个情绪；`【生气×2】`/`×3` 把摆幅放大到 1.35/1.7 倍 |
| `**词**` | 重音：放慢 12%、音量 +5%、抬调 |
| `*词*` | 轻声：快一点、音量 -4%、压低 |

有标记就照标记演，没标记才走 auto 关键词打分。

**情绪基调** `--mood`：

| mood | 效果 |
|---|---|
| `auto`（默认） | **逐句自动判断情绪**：关键词+标点打分（兴奋/开心/低落/生气/惊讶/温柔/害羞），段落开头重置、段内弱信号跟随前句（防一句一变的抽搐感）、换情绪需过滞回阈值；情绪转换处多停 0.2 秒换气，`--dry-run` 的 note 标出每句判的情绪与小句位置 |
| `calm` | 全篇平稳叙述 |
| `happy` | 提速 +8%，升调 |
| `excited` | 提速 +18%，大幅升调 |
| `sad` | 放慢 12%，降调 |
| `angry` | 提速 +10%，降调加重音量 |
| `surprised` | 升调 +26（比 excited 还高） |
| `tender` | 放慢 10%，轻柔升调 |
| `shy` 害羞 | 轻声（音量 -5%）、调子偏高、微微慌（快半拍）；句尾语气词轻轻放掉（嘛→嘛～），「……」是欲言又止而不是难过 |
| `tsundere` 傲娇 | 奇数句又凶又快（高调提速、停顿短），偶数句突然放软（降调放慢、停顿长），口是心非的摇摆感 |
| `sajiao` 撒娇 | 句尾语气词拖长（啦→啦～～、嘛→嘛～～），整体放慢 18%、升调，念出来自然带嗲 |

`--mood` 显式指定时全篇统一该基调（跳过 auto 判情绪）；`node tts.mjs set-mood happy` 可记住默认基调。**长文/故事类文本直接用默认 auto 就有情绪起伏；用户抱怨「没感情/太平」时先确认不是被 `set-mood` 钉在 calm 了。**

### 短剧式配音（drama）

像 AI 短剧的角色配音那样，多角色、带感情地演一场戏：

```bash
node tts.mjs drama --file scene.txt --cast "妹妹=zh-CN-XiaoyiNeural;哥哥=zh-CN-YunxiNeural;旁白=zh-CN-YunyangNeural"
```

台本格式（stdin 也行）：

```text
旁白：夜深了，巷子里只剩一盏灯。
妹妹：【害羞】哥、哥哥……你怎么还没睡呀。

哥哥：【温柔】*等你啊*。**笨蛋**。
妹妹：【开心×2】才、才不信呢！
```

- 每行「角色：台词」，**空行 = 换场**（歇 1.1 秒），换人说话自动留 0.45 秒气口
- 没写角色名的行算旁白；`--cast` 的值可以是 edge 音色或已注册的**克隆音色名**（真人嗓）
- 台词里的情绪标记照常生效；`--dry-run` 先看整场戏的配音计划

**念文学性/戏剧性文本时**：先当导演读一遍戏——谁在说、对谁说、想达到什么、话里藏着什么、这场戏情绪怎么走——把读懂的东西标成情绪标记和轻重，再交给嗓子演。关键词打分只是没标记时的兜底。

### 列音色

```bash
node tts.mjs voices --lang zh    # 中文优先排列，* 标记当前默认
```

末尾会报告三个引擎的状态：`edge 引擎：可用/未安装`、`clone 引擎：可用/未就绪` 及已注册的克隆音色。**不确定当前能用什么时先跑这条**。

高品质中文声音推荐（macOS 需先在 `系统设置 → 辅助功能 → 朗读内容 → 管理语音` 下载）：`Yue (Premium)`（月）、`Tiantian (Enhanced)`（田田增强版）、`Tingting`（婷婷）、Siri 系列。say 引擎默认自动选择顺序：记住的音色 > Premium > 增强版/Siri > Tiantian > Tingting > 任意中文。

### 朗读文本

```bash
node tts.mjs speak "要朗读的文字"                          # auto 引擎
node tts.mjs speak --mood happy "…"                       # 带情绪
node tts.mjs speak --voice Tingting --rate 200 "…"        # 指定音色与语速（say: wpm 默认 200；edge: ±%）
node tts.mjs speak --engine edge --voice zh-CN-YunxiNeural "…"  # 换 edge 音色（男声云希等）
node tts.mjs speak --voice xishi "…"                      # 用克隆音色（自动走 clone 引擎）
node tts.mjs speak --file /path/to/article.md             # 朗读整个文件
cat some.txt | node tts.mjs speak                         # 管道输入
node tts.mjs speak --dry-run "…"                          # 先看净化结果+逐句韵律计划+auto 判的情绪，不真念
```

- **前台阻塞直到念完**，所以长文朗读时不要再并发执行其它 speak
- 自动净化：代码块只去围栏保留正文（歌词不丢）、链接只留文字、网址/markdown 记号/装饰符号（《》～【】☆★等）不念
- 记住音色：`node tts.mjs set-voice "Yue (Premium)"`（say）、`set-voice zh-CN-XiaoxiaoNeural --engine edge`、`set-voice xishi --engine clone`——加 `--engine` 就是记住对应引擎的主嗓
- 引擎自动选择（`--engine say|edge|clone` 可显式指定）：显式指定 > 克隆音色名/已设克隆主嗓 > edge > say

### 停止朗读

```bash
node tts.mjs stop
```

用户说「别念了 / 停」时立即执行，不要等念完。

### 出声互斥（同一时刻只有一个声音）

`speak` 一开口就认领「出声令牌」（`~/.dsh/dsh-tts-reader/playback.json`，念完自动释放，`stop` 也会清掉），插件的自动朗读 / 朗读按钮看到令牌就让路：

- 念诗（或任何 `speak`）进行中：**朗读声不响起**——正在念的立刻闭嘴，还没开口的等念完再念；
- 念过的内容（记在 `recited.jsonl`）**不会被朗读声复读**，防止一首诗被两把嗓子各念一遍。

所以：想让某段话只有一把嗓子念（比如念诗），用 `speak` 真念就行，不用操心插件会不会抢话。

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
4. 克隆朗读慢（单句约 10~20 秒）：短句用着玩没问题，长文先提醒主人或改用 edge/say；注册音色时 `--ref-text` 必须与音频内容一致
5. API Key 只写入本机 `config.json`，绝不回显完整值、绝不写进会话外的任何地方
6. 用户没给歌词又想要纯音乐：`gen --style "…"` 歌词留空即可，不必追问
7. 详细安装（mlx-serve 唱歌引擎、模型下载、edge/F5 朗读引擎、内网穿透等）见 [references/setup.md](references/setup.md)
