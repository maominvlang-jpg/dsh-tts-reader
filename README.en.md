# dsh-tts-reader

Adds a **"Read aloud" button** to [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): one click speaks the latest AI reply of the CURRENT conversation, synthesized locally in your browser. Nothing is uploaded.

## Features

- **Per-conversation reading**: click in a conversation and it reads that conversation's newest reply; idle conversations work too (falls back to reading the on-disk session log)
- **Stops on conversation switch**: switching conversations mid-speech stops the voice immediately
- **Cleaned-up speech**: code-block CONTENT is read (lyrics are not lost), while icons/emojis, decorative punctuation (《》～ 【】 etc.), images, URLs and markdown markup are never spoken; `，。！？` act as pauses only
- **Voice picker**: a dropdown lists every system voice (Chinese first) and remembers your choice
- **🎤 Sing (local, free)**: powered by the open-source ACE-Step 1.5 music model (MLX build, native on Apple Silicon) — type lyrics and a style and get a full vocal track on your machine: free, unlimited, offline, nothing leaves your computer
- **🎤 Sing (cloud, optional)**: switch to any Suno-compatible API reseller (bring your own key)
- **Localized UI**: button labels follow the DSH interface language (zh/en)

## Install

```sh
dsh plugin --profile desktop add github:maominvlang-jpg/dsh-tts-reader
```

Replace `desktop` with your profile name (`dsh profile list` shows it).

Then **restart DSH** and do a **hard refresh (Ctrl/Cmd+Shift+R)** — DSH caches plugin assets aggressively.

## Usage

1. Open any conversation; the **Read latest reply** pill sits below the message composer
2. Click to start, click again to stop
3. Use the dropdown next to it to switch voices
4. When a conversation has no reply yet, the button says so and reads the newest one instead

### 🎤 Singing

Pick a mode at the top of the panel:

**💻 Local (free, recommended)** — no account needed:
1. One-time engine install:
   ```sh
   brew tap ddalcu/mlx-serve https://github.com/ddalcu/mlx-serve
   brew trust ddalcu/mlx-serve && brew install mlx-serve
   ```
2. One-time model download (~6.6 GB) into `~/.mlx-serve/models/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit/` (from Hugging Face or hf-mirror.com)
3. Start the engine: `mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight` (a LaunchAgent makes it start at login)
4. Panel → **💻 Local** → style → lyrics (empty = instrumental) → generate. About 4 seconds for a 30-second song on M-series

**☁️ Cloud (Suno reseller)**: register and top up at [sunoapi.org](https://sunoapi.org) → paste the API key in the panel → generate. Billed by the provider.

Notes: local mode is fully offline; songs are cached in `~/.dsh/dsh-tts-reader/songs/`. Speaking and singing are mutually exclusive; switching conversations stops both.

### Better voices

Browsers can only use installed system voices. On macOS, download premium Chinese voices under
`System Settings → Accessibility → Spoken Content → Manage Voices → Chinese` (Siri voices or Tingting), then pick them in the dropdown.

## How it works

```
Host half (index.js)                      Client half (client.js)
───────────────────                       ───────────────────────
listens to session/event feeds            registers the button + voice picker
  caches each conversation's newest         into conversation.composer.dock
  assistant reply                          on click: resolve the shown session id,
on miss: memory session →                    fetch /dsh-tts/latest?session=<id>
  on-disk log replay via                     speak locally with Web Speech API
  sessionQuery.readSession
GET /dsh-tts/latest ─────────────────────▶
```

- Reading happens fully **locally in your browser**; the reply text only travels over the loopback address (127.0.0.1)
- Includes a Chrome long-utterance (~15s) cut-off workaround
- Subagent (agent-teams teammate) replies never enter the cache

## Compatibility

- Works on DSH `0.1.5-rc.x` / `0.1.7-rc.x` / `0.2.0-rc.x` version lines
- Declares **no** `@deepseek-ai/dsh-*` peerDependencies (host services are accessed defensively), so the version gate never skips it
- Only standard browser APIs (`speechSynthesis`; Chrome / Edge / Safari)

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-tts-reader
```

## License

[MIT](LICENSE)
