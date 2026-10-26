# 本机唱歌引擎（mlx-serve + ACE-Step）安装手册

仅在 `song.mjs health` 报「引擎无响应」且用户希望使用本机免费唱歌时阅读本文件。一次性安装，之后永久离线使用。

## 1. 安装引擎（Homebrew，一次性）

```bash
brew tap ddalcu/mlx-serve https://github.com/ddalcu/mlx-serve
brew trust ddalcu/mlx-serve && brew install mlx-serve
```

## 2. 下载模型（一次性，约 6.6GB）

模型目录必须是：

```
~/.mlx-serve/models/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit/
```

来源：HuggingFace（`mlx-community/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit`）或国内镜像 hf-mirror.com。国内建议：

```bash
pip install -U huggingface_hub
export HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download mlx-community/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit \
  --local-dir ~/.mlx-serve/models/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit
```

## 3. 启动引擎

```bash
mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight
```

- 验证：`node song.mjs health` 应返回 `{"status":"ok"}`
- 首次加载模型需要一些时间，期间请求会排队（不要并发提交多个生成任务）
- 建议做成 LaunchAgent 开机自启：

```bash
cat > ~/Library/LaunchAgents/commlx.serve.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>commlx.serve</string>
  <key>ProgramArguments</key><array>
    <string>mlx-serve</string><string>--serve</string><string>--port</string><string>8080</string>
    <string>--model-dir</string><string>REPLACE_ME/.mlx-serve/models</string>
    <string>--skip-mem-preflight</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
# 把 REPLACE_ME 换成实际 home 路径后：
launchctl load ~/Library/LaunchAgents/commlx.serve.plist
```

## 4. 云端备选（Suno 兼容中转）

本机不想装引擎时，可用任意 Suno 兼容中转 API（如 sunoapi.org，按其定价计费）：

```bash
node song.mjs config set apiKey "sk-xxxx"
node song.mjs config set provider cloud     # 可省略，gen --provider cloud 即可
node song.mjs config set baseUrl "https://api.sunoapi.org"   # 换中转站时
```

Key 只保存在本机 `~/.dsh/dsh-tts-reader/config.json`（权限 600）。

## 5. 排障

| 症状 | 处理 |
|---|---|
| health 超时 | 引擎未启动或端口被占；`lsof -i :8080` 检查 |
| 生成中报 ECONNREFUSED | 引擎正忙或刚重启，等几秒重试 |
| HTTP 5xx + 模型加载错误 | 模型目录名不对或下载不完整，核对目录名与文件数 |
| 歌词被吞字 | 歌词自动延长仍不够时显式加大 `--duration`（上限 600s） |

## 6. 朗读引擎增强（可选，一次性）

`tts.mjs` 的 edge 在线音色与 F5 声音克隆分别装在 `~/.dsh/dsh-tts-reader/venv` 和 `venv-f5`，装好后自动识别、无需配置：

```bash
# edge-tts 在线音色（约 20MB；朗读时需联网）
python3 -m venv ~/.dsh/dsh-tts-reader/venv
~/.dsh/dsh-tts-reader/venv/bin/pip install edge-tts

# F5 声音克隆（MLX，仅 M 系芯片；模型首次使用时自动下载，约 1GB）
python3 -m venv ~/.dsh/dsh-tts-reader/venv-f5
~/.dsh/dsh-tts-reader/venv-f5/bin/pip install f5-tts-mlx
```

验证：`node tts.mjs voices` 末尾应显示 `edge 引擎：可用` / `clone 引擎：可用`（clone 首次注册音色后 `voice-clone/` 目录才会出现）。

- f5-tts-mlx 与新版 mlx 的兼容问题（`random.normal` 参数类型变化）已由 `scripts/clone_speak.py` 在 import 前自动打补丁，无需手改 site-packages
- 都不装也能用：`say` 引擎完全离线，永远可用
