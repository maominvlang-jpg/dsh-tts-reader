#!/usr/bin/env node
/**
 * tts.mjs — 朗读（Read Aloud）脚本，dsh-tts-reader skill 的朗读半边。
 *
 * 两个引擎，自动选择：
 *   edge — 微软 Edge 神经语音（venv 里的 edge-tts，需联网），自然、有起伏
 *   say  — macOS 原生 say（完全离线兜底；Premium/Enhanced 音色也较自然）
 *
 * 情绪与韵律：
 *   --mood auto（默认）    逐句自动判断情绪（关键词+标点打分，段内连贯），
 *                         不同段落/句子用不同情绪念
 *   --mood happy/sad/…    整体基调（rate/pitch/volume 偏移，全篇统一）
 *   逐句自动调制：问句升调、感叹句提速提调、省略号放慢降调、
 *   长句中段轻微降速 —— 让平文本念出人味。
 *
 * 用法：
 *   node tts.mjs voices [--lang zh]          列出可用音色（* 为当前默认）
 *   node tts.mjs speak [options] [text...]   朗读（文本参数缺省时读 stdin）
 *     --engine auto|edge|say   默认 auto（edge 可用则用 edge）
 *     --voice <name>           音色（edge 用 zh-CN-XiaoxiaoNeural 这类 id；say 用系统音色名）
 *     --mood <基调>            auto|calm|happy|sad|excited|angry（默认 auto：逐句判情绪）
 *     --rate <wpm 或 ±%>       say 用 wpm（默认 200）；edge 用 ±%（如 +10%）
 *     --file <path>            从文件读取要朗读的文本（utf-8）
 *     --dry-run                只打印逐句韵律计划，不朗读
 *   node tts.mjs stop                           停止当前朗读（含 afplay）
 *   node tts.mjs set-voice <name> [--engine]    记住默认音色
 *   node tts.mjs set-mood <mood>                记住默认情绪基调
 *
 * 退出码：0 成功；1 用法/环境错误；2 朗读失败。
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = join(homedir(), '.dsh', 'dsh-tts-reader');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const TMP_DIR = join(CONFIG_DIR, 'tts-tmp');
const EDGE_BIN = join(CONFIG_DIR, 'venv', 'bin', 'edge-tts');
const F5_PY = join(CONFIG_DIR, 'venv-f5', 'bin', 'python3');
const CLONE_DIR = join(CONFIG_DIR, 'voice-clone');

const loadConfig = () => {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
};

const saveConfig = (patch) => {
  const merged = { ...loadConfig(), ...patch };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
};

// ── 出声令牌：同一时刻只让一个声音说话 ─────────────────────────────────
// speak 一开口就认领令牌并持续心跳；插件的自动朗读/朗读按钮通过 Host 的
// /dsh-tts/playback 看到令牌就静音让路（正在念的立刻闭嘴，还没开口的等念完
// 再念），念完释放。这样「念诗的嗓子」和「朗读的嗓子」永远不会叠在一起。
const PLAYBACK_FILE = join(CONFIG_DIR, 'playback.json');
/** 念过什么记在这里（最近 50 条）：朗读声不再复读已念过的内容。 */
const RECITED_FILE = join(CONFIG_DIR, 'recited.jsonl');
const HEARTBEAT_MS = 800;
/** 令牌多久没心跳就算过期（Host 端同口径判定）。 */
const PLAYBACK_TTL_MS = 4000;

/** 原子写令牌文件，读方不会看到写了一半的 JSON。 */
const writePlayback = (state) => {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${PLAYBACK_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, PLAYBACK_FILE);
};

/** 释放令牌（只清自己的，避免误删别人的）。 */
const releasePlayback = () => {
  try {
    const cur = JSON.parse(readFileSync(PLAYBACK_FILE, 'utf8'));
    if (cur?.pid !== process.pid) return;
  } catch {}
  rmSync(PLAYBACK_FILE, { force: true });
};

/**
 * 认领出声通道：写令牌 + 记一笔念稿 + 起心跳。返回 release()，念完（或失败
 * 收场）都要调；即使忘了调，进程一退出令牌也会失效（Host 看进程存活）。
 */
const claimPlayback = (text) => {
  const startedAt = Date.now();
  writePlayback({ owner: 'cli', pid: process.pid, phase: 'starting', startedAt, beatAt: startedAt, text: text.slice(0, 1500) });
  try {
    const lines = existsSync(RECITED_FILE) ? readFileSync(RECITED_FILE, 'utf8').split('\n').filter(Boolean) : [];
    lines.push(JSON.stringify({ at: startedAt, text: text.slice(0, 1500) }));
    writeFileSync(RECITED_FILE, lines.slice(-50).join('\n') + '\n', { mode: 0o600 });
  } catch {}
  const beat = setInterval(() => {
    try {
      const cur = JSON.parse(readFileSync(PLAYBACK_FILE, 'utf8'));
      if (cur?.pid !== process.pid) return; // 被 stop 清掉了，别复活它
      writePlayback({ ...cur, phase: 'playing', beatAt: Date.now() });
    } catch {}
  }, HEARTBEAT_MS);
  return () => {
    clearInterval(beat);
    releasePlayback();
  };
};

/** `say -v '?'` 的一行形如：`Tingting            zh_CN    # 你好，我叫婷婷。` */
const listVoices = () => {
  const out = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const name = line.slice(0, 20).trim();
    const lang = line.slice(20, 28).trim();
    const sample = line.slice(28).replace(/^#\s*/, '').trim();
    return { name, lang, sample };
  }).filter((v) => v.name !== '');
};

/** edge-tts 是否可用（venv 已装 + 能联网由实际调用兜底）。 */
const edgeAvailable = () => existsSync(EDGE_BIN);

// ── clone 引擎：F5-TTS-MLX 零样本音色克隆 ─────────────────────────────
// 音色库：~/.dsh/dsh-tts-reader/voice-clone/<name>/ 下放
//   ref_24k.wav  参考音频（afconvert 转好的 24kHz 单声道）
//   meta.json    { refText: "参考音频的台词原文", source: "原始文件" }
const cloneAvailable = () => existsSync(F5_PY) && existsSync(CLONE_DIR);

/** 列出已注册的克隆音色名。 */
const cloneVoices = () => {
  try {
    return readdirSync(CLONE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(CLONE_DIR, e.name, 'ref_24k.wav')))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const cloneVoiceDir = (name) => {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    console.error('音色名只能小写字母/数字/连字符，1~32 位');
    process.exit(1);
  }
  return join(CLONE_DIR, name);
};

/** 注册克隆音色：任意音频 → afconvert 转 24kHz wav → 记录台词。 */
const registerCloneVoice = (name, audioPath, refText) => {
  const dir = cloneVoiceDir(name);
  if (!existsSync(audioPath)) { console.error(`音频不存在：${audioPath}`); process.exit(1); }
  if (!refText || refText.trim() === '') { console.error('必须提供参考音频的台词 --ref-text（F5 靠它对齐）'); process.exit(1); }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wav = join(dir, 'ref_24k.wav');
  // F5 硬性要求 24kHz；单声道更稳
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', audioPath, wav], { stdio: 'ignore' });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ refText: refText.trim(), source: audioPath }, null, 2));
  console.log(`✅ 克隆音色已注册：${name}`);
  console.log(`   参考音频：${wav}（试听：afplay "${wav}"）`);
  console.log(`   使用：node tts.mjs speak --engine clone --voice ${name} "要念的话"`);
};

/** clone 引擎：把韵律计划合成为一个 wav 文件（不播放），返回文件路径。
 *  插件 Host 端预合成、「朗读最新回复」按钮播它，都走这条路。 */
const renderClone = (plan, voiceName, outFile) => {
  const dir = cloneVoiceDir(voiceName);
  const ref = join(dir, 'ref_24k.wav');
  if (!existsSync(ref)) throw new Error(`克隆音色不存在：${voiceName}`);
  const { refText } = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const bridge = join(dirname(fileURLToPath(import.meta.url)), 'clone_speak.py');
  // ffmpeg 可能不在 GUI 应用继承的精简 PATH 里，按常见安装位置兜底
  const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => existsSync(p)) ?? 'ffmpeg';
  const work = join(TMP_DIR, `render-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    // 批量模式：一个进程合成全部句子（模型只加载一次，euler 采样）
    const batchPlan = join(work, 'plan.json');
    writeFileSync(batchPlan, JSON.stringify({
      ref, ref_text: refText,
      segments: plan.map((seg) => ({ text: seg.sentence, speed: seg.rate })),
    }));
    const stdout = execFileSync(F5_PY, [bridge, '--batch', batchPlan, '--out-dir', work], { encoding: 'utf8' });
    const files = JSON.parse(stdout.trim().split('\n').at(-1)).files;
    const items = files
      .map((file, i) => ({ file, pause: i < plan.length - 1 ? Math.round(plan[i].pause * 20) / 20 : 0 }))
      .filter((item) => item.file);
    // 句间停顿用静音片段实现，concat 一次性拼接
    const silCache = new Map();
    const silence = (sec) => {
      const key = sec.toFixed(2);
      if (!silCache.has(key)) {
        const f = join(work, `sil_${key.replace('.', '')}.wav`);
        execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', key, '-c:a', 'pcm_s16le', f], { stdio: ['ignore', 'ignore', 'pipe'] });
        silCache.set(key, f);
      }
      return silCache.get(key);
    };
    const lines = [];
    for (const item of items) {
      lines.push(`file '${item.file}'`);
      if (item.pause > 0) lines.push(`file '${silence(item.pause)}'`);
    }
    const listFile = join(work, 'list.txt');
    writeFileSync(listFile, lines.join('\n') + '\n');
    mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return outFile;
};

/** clone 引擎：逐句调 F5 合成（每句都带音色参考），句间按计划停顿。 */
const speakClone = async (plan, voiceName, dryRun, quiet = false) => {
  const dir = cloneVoiceDir(voiceName);
  const ref = join(dir, 'ref_24k.wav');
  if (!existsSync(ref)) { console.error(`克隆音色不存在：${voiceName}（已注册：${cloneVoices().join(', ') || '无'}）`); process.exit(1); }
  const { refText } = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const bridge = join(dirname(fileURLToPath(import.meta.url)), 'clone_speak.py');

  if (dryRun) {
    for (const seg of plan) console.log(`  [${seg.note}] speed=${seg.rate.toFixed(2)} pause=${seg.pause}s  ${seg.sentence.slice(0, 40)}${seg.sentence.length > 40 ? '…' : ''}`);
    console.log(`(clone 引擎 · ${voiceName}，F5-TTS-MLX，${plan.length} 句)`);
    return;
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  if (!quiet) console.log(`克隆朗读中（${voiceName} · F5，${plan.length} 句，边合成边念哦）…`);
  // 批量模式：python 进程一次合成全部句子（模型只加载一次），
  // stderr 每出现一行「合成中 i/N」= 第 i-1 句已写盘，立刻开播，不等后面的。
  const batchPlan = join(TMP_DIR, 'plan.json');
  writeFileSync(batchPlan, JSON.stringify({
    ref, ref_text: refText,
    segments: plan.map((seg) => ({ text: seg.sentence, speed: seg.rate })),
  }));
  const done = new Promise((resolve, reject) => {
    const child = spawn(F5_PY, [bridge, '--batch', batchPlan, '--out-dir', TMP_DIR]);
    let played = 0;
    let stderrTail = '';
    let playing = Promise.resolve(); // 播放互斥：一次只播一句
    const playNext = () => {
      playing = playing.then(async () => {
        while (played < plan.length) {
          const file = join(TMP_DIR, `seg_${String(played).padStart(3, '0')}.wav`);
          if (!existsSync(file)) break;
          process.stderr.write('\r播放中 ' + ' '.repeat(20) + '\r');
          try {
            execFileSync('afplay', [file], { stdio: 'ignore' });
          } catch { return; } // 被 stop 杀掉
          const pause = played < plan.length - 1 ? plan[played].pause : 0;
          played += 1;
          if (pause > 0) await nap(pause);
        }
      });
      return playing;
    };
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk;
      playNext(); // 新句写盘了就试着开播，不等合成全完
    });
    child.on('error', reject);
    child.on('close', (code) => {
      playNext()
        .then(() => (code === 0 ? resolve() : reject(new Error(`clone 合成进程退出码 ${code}：${stderrTail.slice(-300)}`))))
        .catch(reject);
    });
  });
  try {
    await done;
  } catch (error) {
    console.error(`\n克隆合成失败：${String(error?.message ?? error).slice(0, 300)}`);
    process.exit(2);
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (!quiet) console.log('克隆朗读完毕');
};

const pickDefaultSayVoice = (voices) => {
  const saved = loadConfig().voiceSay;
  if (typeof saved === 'string' && voices.some((v) => v.name === saved)) return saved;
  // 神经网络音色优先：Premium（Yue） > Enhanced（田田） > Siri > 婷婷
  const zh = voices.filter((v) => v.lang.startsWith('zh'));
  const premium = zh.find((v) => /\(Premium\)/i.test(v.name));
  if (premium) return premium.name;
  const enhanced = zh.find((v) => /\(Enhanced\)|Siri/i.test(v.name));
  if (enhanced) return enhanced.name;
  const tiantian = zh.find((v) => /Tiantian/i.test(v.name));
  if (tiantian) return tiantian.name;
  const tingting = zh.find((v) => /Tingting/i.test(v.name));
  if (tingting) return tingting.name;
  if (zh.length > 0) return zh[0].name;
  return undefined;
};

/** edge 默认音色：晓晓（温暖女声，中文最自然）。 */
const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural';

const pickDefaultEdgeVoice = () => {
  const saved = loadConfig().voiceEdge;
  return typeof saved === 'string' && saved !== '' ? saved : DEFAULT_EDGE_VOICE;
};

// ── 情绪基调：rate/pitch/volume 的整体偏移 + 语调幅度 range ─────────────
// range = 音高起伏的「宽窄」：兴奋/惊讶大起大落，难过压得很平（真人难过时
// 语调本来就是平的）。这是「有高有低」的来源；温柔≠平淡，照样要起伏。
const MOODS = {
  // auto 不是固定基调：逐句打分判情绪（见 detectSegmentMood），占位只为参数校验
  auto:     { rate: 0.00, pitch: 0,  volume: 0, range: 1.1 },
  calm:     { rate: 0.00, pitch: 0,  volume: 0, range: 1.1 },
  happy:    { rate: 0.08, pitch: 12, volume: 3, range: 1.3 },
  excited:  { rate: 0.18, pitch: 22, volume: 6, range: 1.5 },
  sad:      { rate: -0.12, pitch: -10, volume: -5, range: 0.7 },
  angry:    { rate: 0.10, pitch: -4, volume: 8, range: 1.25 },
  surprised:{ rate: 0.06, pitch: 26, volume: 2, range: 1.45 },
  tender:   { rate: -0.10, pitch: 6, volume: -4, range: 1.0 },
  // 害羞：轻声细语、调子偏高、微微慌（比平时快半拍），句尾轻轻放掉
  shy:      { rate: 0.04, pitch: 10, volume: -5, range: 1.1 },
  // 傲娇：一句凶一句软地摇摆（见 planProsody 装饰），整体偏快偏高
  tsundere: { rate: 0.02, pitch: 4, volume: 3, range: 1.35 },
  // 撒娇：整体放慢，尾音拖长（好啦 → 好啦～～）
  sajiao:   { rate: -0.18, pitch: 14, volume: -3, range: 1.2 },
};

const usage = () => {
  console.error(`用法：
  node tts.mjs voices [--lang zh]        列出 say 可用音色（* 为当前默认）
  node tts.mjs speak [options] [text]    朗读；文本缺省时读 stdin
      --engine auto|edge|say|clone  默认 auto（指定 clone 音色名时自动用 clone）
      --voice <name>           音色（clone: 注册名；edge: zh-CN-XiaoxiaoNeural；say: 系统音色名）
      --mood auto|calm|happy|sad|excited|angry|surprised|tender|shy|tsundere|sajiao
                               情绪基调（默认 auto：逐句自动判断，不同句子不同情绪）
      --rate <wpm 或 ±%>       say: wpm（默认 200）；edge: ±%
      --file <path>            从 utf-8 文件读取文本
      --dry-run                只打印韵律计划
  node tts.mjs drama --file <台本.txt> [--cast "名=音色;名=音色"] [--mood auto]
      短剧式配音：每行「角色：台词」，空行换场，没写角色名的行算旁白；
      台词里可带【情绪】【生气×2】**重音** *轻声*；--cast 的值可以是 edge 音色
      或已注册的克隆音色名
  node tts.mjs stop                          停止朗读
  node tts.mjs set-voice <name> [--engine say|edge|clone]   记住音色
  node tts.mjs set-mood <mood>               记住情绪基调
  node tts.mjs clone-voice --name <id> --audio <音频> --ref-text "<参考音频台词>"
      注册 F5 克隆音色（任意格式音频自动转 24kHz；台词必须与音频内容一致）`);
};

const parseArgs = (argv) => {
  const opts = { text: [], voice: undefined, rate: undefined, file: undefined, lang: 'zh', dryRun: false, engine: undefined, mood: undefined, out: undefined, cast: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--rate') opts.rate = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--cast') opts.cast = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--engine') opts.engine = argv[++i];
    else if (a === '--mood') opts.mood = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else opts.text.push(a);
  }
  return opts;
};

const readStdin = () => new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => resolve(data));
  if (process.stdin.isTTY) resolve(data);
});

/** 内容净化（与插件版一致的原则）；保留段落分隔用于「喘气」。 */
const cleanText = (text) => text
  .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*/g, ''))
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, '')
  // 颜文字不念：(￣o￣)（ฅ´>ω•ฅ）(*^▽^*)_(:з」∠)_ —— 短括号组且含装饰符号、无汉字
  .replace(/[（(][^一-鿿（）()]{1,14}[）)]/g, (m) => (/[￣ω▽☆♪•´ฅ><・εз∀∧∠□]/u.test(m) ? ' ' : m))
  // 无括号的裸颜文字与装饰条：￣ω￣、☆★～连排
  .replace(/[￣▽☆★♪・•]{2,}/g, ' ')
  // 睡觉记号 zzZ / zzz 不念
  .replace(/\bzz+z?\b/gi, ' ')
  .replace(/[#*_`~>|\\-]+/g, ' ')
  .replace(/[《》【】「」『』·—…☆★♪]+/g, (m) => (m.includes('…') ? '……' : ''))
  .replace(/[ \t]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')      // 行内换行保留为段落线索
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// ── 情绪标记：让「读懂了文字感情」的那位直接给每句标情绪和轻重 ─────────
// 引擎的关键词打分只是猜；真正理解感情的是写这段文本的那位（AI/人）。
// 标记写在 speak 的文本里（聊天正文不要带）：
//   【害羞】【温柔】【生气×2】[happy] —— 之后的句子用这个情绪，×2/×3 加大摆幅
//   **词** —— 重音（放慢 12%、音量 +5%、抬调）
//   *词*  —— 轻声（快一点、音量 -4%、压低）
const MOOD_NAME_MAP = {
  平静: 'calm', 安静: 'calm', 开心: 'happy', 高兴: 'happy', 兴奋: 'excited', 激动: 'excited',
  低落: 'sad', 难过: 'sad', 伤心: 'sad', 生气: 'angry', 愤怒: 'angry', 惊讶: 'surprised',
  温柔: 'tender', 害羞: 'shy', 撒娇: 'sajiao', 傲娇: 'tsundere',
  calm: 'calm', happy: 'happy', excited: 'excited', sad: 'sad', angry: 'angry',
  surprised: 'surprised', tender: 'tender', shy: 'shy', sajiao: 'sajiao', tsundere: 'tsundere',
};
const MARK_IN = '\uE000';
const MARK_OUT = '\uE001';
const EMPH_IN = '\uE002';
const EMPH_OUT = '\uE003';
const SOFT_IN = '\uE004';
const SOFT_OUT = '\uE005';

/** 进引擎前编码标记：cleanText 会把【】和 ** 当装饰符号吃掉，先换成暗码。 */
const encodeMarks = (text) => String(text)
  .replace(
    /【\s*([一-鿿a-zA-Z]{1,6})\s*(?:[×x*]\s*([1-3]))?\s*】|\[\s*([一-鿿a-zA-Z]{1,6})\s*(?:[×x*]\s*([1-3]))?\s*\]/gu,
    (m, a, b, c, d) => {
      const key = MOOD_NAME_MAP[((a ?? c) ?? '').trim().toLowerCase()];
      return key ? `${MARK_IN}${key}.${b ?? d ?? '1'}${MARK_OUT}` : ' ';
    },
  )
  .replace(/\*\*([^*]+?)\*\*/gu, (m, w) => `${EMPH_IN}${w}${EMPH_OUT}`)
  .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/gu, (m, pre, w) => `${pre}${SOFT_IN}${w}${SOFT_OUT}`);

/** 按情绪标记把文本切成 run：{ text, mood, strength }；mood 为 null = 没标记。
 *  标记的管辖范围：从标记起，到下一个标记或空行（段落）为止。 */
const splitMoodRuns = (text) => {
  const pieces = []; // { text, mark }：mark = { mood, strength } 表示这里有个标记
  let rest = String(text);
  for (;;) {
    const m = new RegExp(`${MARK_IN}([a-z]+)\\.([1-3])${MARK_OUT}`, 'u').exec(rest);
    if (m === null) { pieces.push({ text: rest, mark: null }); break; }
    pieces.push({ text: rest.slice(0, m.index), mark: null });
    pieces.push({ text: '', mark: { mood: m[1] in MOODS ? m[1] : null, strength: Number(m[2]) || 1 } });
    rest = rest.slice(m.index + m[0].length);
  }
  const runs = [];
  let carry = { mood: null, strength: 1 };
  for (const piece of pieces) {
    if (piece.mark !== null) { carry = piece.mark; continue; }
    const blocks = piece.text.split(/\n{2,}/u);
    for (const [bi, block] of blocks.entries()) {
      // paraEnd：这段后面是空行 → 段落收尾，给「大喘气」
      if (block.trim() !== '') runs.push({ text: block, mood: carry.mood, strength: carry.strength, paraEnd: bi < blocks.length - 1 });
      if (blocks.length > 1) carry = { mood: null, strength: 1 }; // 空行 = 标记到此为止
    }
  }
  return runs.length > 0 ? runs : [{ text: String(text), mood: null, strength: 1, paraEnd: false }];
};

/** 把一小句按 **重音** / *轻声* 切成发音单元：[{ text, weight }]（weight: 1 普通 / 2 重 / 0 轻）。 */
const splitEmphasis = (clause) => {
  const source = String(clause);
  if (!source.includes(EMPH_IN) && !source.includes(SOFT_IN)) return [{ text: source, weight: 1 }];
  const out = [];
  const re = new RegExp(`${EMPH_IN}([^${EMPH_IN}${EMPH_OUT}]+)${EMPH_OUT}|${SOFT_IN}([^${SOFT_IN}${SOFT_OUT}]+)${SOFT_OUT}`, 'u');
  let rest = source;
  for (;;) {
    const m = re.exec(rest);
    if (m === null) {
      if (rest.trim() !== '') out.push({ text: rest, weight: 1 });
      break;
    }
    const head = rest.slice(0, m.index);
    if (head.trim() !== '') out.push({ text: head, weight: 1 });
    out.push({ text: m[1] ?? m[2], weight: m[1] !== undefined ? 2 : 0 });
    rest = rest.slice(m.index + m[0].length);
  }
  // 纯标点碎片并回上一个单元（「……」这种单独合成会出怪声）
  const merged = [];
  for (const unit of out) {
    if (!/[\p{L}\p{N}]/u.test(unit.text) && merged.length > 0) {
      merged[merged.length - 1].text += unit.text;
      continue;
    }
    merged.push({ ...unit });
  }
  return merged.filter((u) => u.text.trim() !== '');
};

// ── auto 情绪：逐句打分判情绪 ─────────────────────────────────────
// 每句按「关键词命中 + 标点信号」给各情绪打分，最高分的情绪获胜；
// 分数太弱时跟随上一句（连读感，避免一句一变的抽搐感）。
// 换情绪需要新情绪比当前情绪多出阈值分（滞回），让情绪成段地走。
const MOOD_LEXICON = {
  excited: [[/太棒|好耶|万岁|赢了|成功了|终于|哈哈|芜湖|激动|兴奋|热血/, 2], [/！！|啊啊/, 2]],
  happy:   [[/开心|高兴|喜欢|美好|幸福|愉快|笑|甜|暖|谢谢|感谢|真棒|好棒|可爱|阳光/, 1.5], [/[嘻嘿]嘻|啦啦/, 1]],
  sad:     [[/哭|泪|难过|伤心|悲伤|离开|再见|孤独|寂寞|想念|思念|失去|遗憾|后悔|去世|痛/, 2], [/唉|可惜|算了|对不起|抱歉/, 1], [/…{1,2}\s*$/u, 1]],
  angry:   [[/气死|讨厌|恨|烦|滚|可恶|过分|凭什么|垃圾|混蛋|怒|吼|骂/, 2], [/！！/, 1]],
  surprised: [[/居然|竟然|没想到|不敢相信|真的假的|不会吧|咦|哎[？?]/, 2], [/[？?！!]{2,}/, 1]],
  tender:  [[/轻轻|慢慢|悄悄|温柔|安静|睡|梦|月光|星星|拥抱|怀抱|陪你|陪着|晚安|辛苦/, 1.5], [/嗯|啦|哦|呀/u, 0.3]],
  // 害羞：脸红、支吾、「才、才没有」那种被戳中要害的小慌张
  shy:     [[/害羞|不好意思|脸红|耳朵[^。！？]*红|红了|才、才没有|才没有|哪有|被发现|不要看|讨厌啦|再说一遍/, 2], [/嘛……|啦……/u, 1]],
};
// 同一规则里命中的每个关键词都计分（晚安+梦 = 双份温柔），单条规则封顶 3 分防爆表
const scoreMood = (sentence) => {
  const scores = {};
  for (const [mood, rules] of Object.entries(MOOD_LEXICON)) {
    let s = 0;
    for (const [re, w] of rules) {
      const hits = sentence.match(new RegExp(re.source, 'gu'));
      s += w * Math.min(hits ? hits.length : 0, 3);
    }
    scores[mood] = s;
  }
  return scores;
};

/** 逐句情绪序列：段落开头重置（新段新场景），段内弱信号跟随前句，换情绪需过滞回。
 *  每项 { mood, strength }：strength 是本句信号浓度，用来放大/收小情绪摆幅。 */
const detectMoods = (items) => {
  const out = [];
  let current = 'calm';
  for (const item of items) {
    if (item.paraStart) current = 'calm'; // 新段落不继承上段情绪，避免「上段生气、这段问候也带怒气」
    const scores = scoreMood(item.sentence);
    let best = 'calm';
    let bestScore = 0;
    for (const [mood, sc] of Object.entries(scores)) {
      if (sc > bestScore) { best = mood; bestScore = sc; }
    }
    // 滞回：新情绪要当红（≥1.5 基本分），且比现任情绪在本句的得分多出 1 分才换
    if (bestScore >= 1.5 && best !== current && bestScore >= (scores[current] ?? 0) + 1) current = best;
    out.push({ mood: current, strength: Math.max(bestScore, scores[current] ?? 0) });
  }
  return out;
};

// 各情绪的停顿性格：sad 慢半拍、excited 紧凑、tender 轻柔
const PAUSE_SCALES = { calm: 1.0, happy: 0.9, excited: 0.65, sad: 1.25, angry: 0.8, surprised: 0.75, tender: 1.2, shy: 1.05, tsundere: 0.85, sajiao: 1.15 };
// auto 模式 note 里的情绪中文名
const MOOD_LABELS = { calm: '平静', happy: '开心', excited: '兴奋', sad: '低落', angry: '生气', surprised: '惊讶', tender: '温柔', shy: '害羞' };

/** 把一句切成小句（、，；：与换行）做语调弧线；碎片太短就往后并，避免「嗯，好呀」切成两口气。
 *  换行也算小句边界（诗行之间要换口气），返回的片段保留尾部标点供停顿判定。 */
const splitClauses = (sentence) => {
  const parts = String(sentence).split(/([、，；：\n])/u);
  const pieces = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? '';
    const delim = parts[i + 1] ?? '';
    if (text === '' && delim === '') continue;
    // 只剩分隔符（「……；\n」）时并给上一片，别单独成句
    if (text === '' && pieces.length > 0) {
      pieces[pieces.length - 1].text += delim;
      pieces[pieces.length - 1].delim = delim;
      continue;
    }
    pieces.push({ text: text + delim, delim });
  }
  if (pieces.length <= 1) return [String(sentence)];
  const letters = (s) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const out = [];
  let buf = '';
  for (const [i, piece] of pieces.entries()) {
    buf += piece.text;
    const isLast = i === pieces.length - 1;
    const nextStartsLine = !isLast && /^\n/u.test(pieces[i + 1].text);
    // 短碎片往后并：只跨 、，；；：与换行前不并，下一片是新诗行也不并
    const short = letters(buf) < 5 && !/[；：\n]$/u.test(buf) && !nextStartsLine;
    if (isLast || !short) { out.push(buf); buf = ''; }
  }
  if (buf !== '') out.push(buf);
  return out.filter((s) => s.trim() !== '');
};

/**
 * 逐句切分并标注韵律与「呼吸」。先按空行分段，段内按句末标点切句，句内再按
 * 、，；：切成小句走**语调弧线**——真人说话不是一字一调，而是起音略高、中段
 * 赶一点、句尾按句型收：
 *   起句（第一小句）—— 调子略沉、稍慢（起音）
 *   承接（中间小句）—— 微升 6Hz、略快（逗号处的延续感）
 *   收尾（最后小句）—— 按句型落：问句 +18Hz 扬起、感叹 +10Hz 提速、
 *                      省略号 -12Hz 放慢放软、陈述 -6Hz 收住
 *   小句间呼吸 —— 顿号 0.14s、逗号 0.2s、分号/冒号 0.28s（各乘情绪的呼吸系数）
 * 段落结束   —— 停 0.9 秒（大喘气，换段落的感觉）
 * 情绪信号越浓，rate/pitch 的摆幅越大（strength → amp，封顶 1.6 倍）。
 * 基调 mood 在此之上整体偏移，并微调停顿长短。
 *   auto（默认）—— 逐句判情绪（detectMoods），每句带自己的基调；
 *                   情绪转换处多停 0.2 秒「换气」，note 标出该句情绪
 * gran 切分粒度：'clause'（默认，edge/say 用）句内也起伏；'sentence'（clone 用）
 * 整句合成——克隆嗓自带真人的起承转合，切碎反而会跳调。
 * 两种「人格化」基调在逐句结果上再做装饰（仅显式指定时）：
 *   tsundere 傲娇 —— 奇数句又凶又快（高调+提速），偶数句突然放软（降调+放慢），
 *                    像「才、才没有特意……哼！」那种口是心非的摇摆
 *   sajiao   撒娇 —— 句尾语气词拖长（啦→啦～～、嘛→嘛～～），整体更慢更嗲
 */
/** 一个情绪 run：一段用同一情绪出声的文本（标记指定，或按 mood/auto 判）。 */
const planRunInto = (run, mood, gran, segs) => {
  // 【害羞】这类标记指定的情绪优先于 --mood 与 auto 打分：写文本的那位最懂这段的感情
  const forced = run.mood !== null && run.mood in MOODS ? run.mood : null;
  const auto = forced === null && mood === 'auto';
  const fixedMood = forced ?? (mood in MOODS ? mood : 'calm');
  // 标记强度：×1 如常、×2 摆幅 1.35 倍、×3 到 1.7 倍
  const forcedAmp = forced !== null ? 1 + (run.strength - 1) * 0.35 : 1;
  // 段落 = 空行分隔；单换行只是诗行换气，不给大喘气
  const paragraphs = String(run.text).split(/\n{2,}/u).map((p) => p.trim()).filter((p) => p !== '');
  // 第一遍：只切句，保留段落结构（run 的收尾句视作段落收尾，段间大喘气）
  const flat = [];
  for (const [pi, para] of paragraphs.entries()) {
    const parts = para.split(/(?<=[。！？!?…])(?=\s*[^。！？!?…]|$)/u).filter((s) => s.trim() !== '');
    for (const [si, raw] of parts.entries()) {
      flat.push({ sentence: raw.trim(), paraStart: si === 0, paraEnd: si === parts.length - 1 && run.paraEnd === true });
    }
  }
  // 纯标点的句子（孤零零的「……」）并进邻句：单独合成只会念出怪声，
  // 并进去正好当一个意味深长的停顿
  const flatClean = [];
  let lead = '';
  for (const item of flat) {
    if (!/[\p{L}\p{N}]/u.test(item.sentence)) {
      if (flatClean.length > 0) flatClean[flatClean.length - 1].sentence += item.sentence;
      else lead += item.sentence;
      continue;
    }
    flatClean.push({ ...item, sentence: lead + item.sentence });
    lead = '';
  }
  if (lead !== '' && flatClean.length > 0) flatClean[flatClean.length - 1].sentence += lead;
  flat.length = 0;
  flat.push(...flatClean);

  // auto：逐句判情绪；固定基调或标记：全段同色
  const segMoods = auto
    ? detectMoods(flat)
    : flat.map(() => ({ mood: fixedMood, strength: 2 }));
  for (const [i, item] of flat.entries()) {
    const sentence = item.sentence;
    const segMood = segMoods[i].mood;
    const base = MOODS[segMood] ?? MOODS.calm;
    const pauseScale = PAUSE_SCALES[segMood] ?? 1.0;
    // 语调幅度：兴奋大起大落、难过压得平（有高有低）；标记 ×2/×3 再放大
    const range = base.range ?? 1;
    // 情绪越浓，摆幅越大（1.0 ~ 1.6 倍）；sad 的慢、excited 的冲随信号走
    const amp = forcedAmp * (auto ? 1 + Math.min(Math.max(segMoods[i].strength - 1.5, 0), 3) / 5 : 1);
    // 句与句之间也要「游」起来：起点不能句句一样高、一样快（平淡的另一个来源）
    const rate0 = (1 + base.rate * amp) * (1 + 0.025 * Math.sin(i * 0.9 + 1));
    const pitch0 = base.pitch * amp + 3 * Math.sin(i * 1.1);

    // 句型决定「句尾怎么落」
    let endPitch = -6; let endRate = 1; let endPause = 0.3; let note = '陈述收音';
    if (/[？?][”"』」)]*\s*$/u.test(sentence)) { endPitch = 18; endRate = 0.96; endPause = 0.4; note = '问句升调'; }
    else if (/[！!][”"』」)]*\s*$/u.test(sentence)) { endPitch = 10; endRate = 1.08; endPause = 0.25; note = '感叹提速'; }
    else if (/…{1,2}\s*$/u.test(sentence)) {
      // 软情绪的「……」是欲言又止（轻轻把尾音放掉），不是难过
      const soft = segMood === 'tender' || segMood === 'shy';
      endPitch = soft ? -5 : -12;
      endRate = 0.85;
      endPause = soft ? 0.75 : 0.7;
      note = soft ? '省略号轻轻放掉' : '省略号放慢';
    }
    else if (sentence.length > 40) { endRate = 0.93; note = '长句降速'; }

    const clauses = gran === 'sentence' ? [sentence] : splitClauses(sentence);
    const k = clauses.length;
    for (const [ci, clause] of clauses.entries()) {
      const last = ci === k - 1;
      // 语调的「山峦」：起音稍高 → 中段拱起小高峰 → 句尾按句型收。
      // t = 这句进行到哪儿（0→1），arc 就是音高的爬升与滑落（不平淡的来源）。
      const t = k > 1 ? ci / (k - 1) : 1;
      const arc = k > 1 ? 8 - 14 * t + 6 * Math.sin(Math.PI * t) : 0;
      let rate;
      let pitch;
      if (last) {
        // 收尾：按句型落，多小句的句子到这儿已经沉下来了，再收一格
        rate = rate0 * (endRate - (k > 1 ? 0.08 : 0));
        pitch = pitch0 + (endPitch - (k > 1 ? 2 : 0)) * range;
      } else {
        // 起承：起音稳一点，中段赶一点、挑一点，越到后面越沉
        rate = rate0 * (ci === 0 ? 0.93 : 1.1);
        pitch = pitch0 + arc * range;
      }
      if (sentence.length > 40) rate *= 0.95;
      // 小句之间的「呼吸」：顿号最短、换行换口气、逗号次之、分号冒号稍作思量
      let pause = last
        ? endPause
        : (/[、]$/.test(clause) ? 0.14 : (/[\n]$/.test(clause) ? 0.25 : (/[；：]$/.test(clause) ? 0.28 : 0.2)));
      pause *= pauseScale;
      let segNote = last ? note : '小句承接';
      if (item.paraEnd && last) { pause = 0.9; segNote += '｜段间大喘气'; }
      // auto：情绪转换处多停半口气（换个表情再开口），note 标出这句的情绪
      if (auto) {
        if (i > 0 && ci === 0 && segMood !== segMoods[i - 1].mood) { pause += 0.2; segNote += '｜换情绪'; }
        segNote = `${MOOD_LABELS[segMood] ?? segMood}·${segNote}`;
      }
      if (k > 1) segNote += `｜小句${ci + 1}/${k}`;
      // 发音单元：**重音**（放慢 12%、加重、抬调）与 *轻声*（快一点、收小声）
      const units = splitEmphasis(clause);
      for (const [ui, unit] of units.entries()) {
        // 小句的呼吸记在它最后一个单元头上；单元之间的缝几乎不留
        const unitLast = ui === units.length - 1;
        let uRate = rate;
        let uPitch = pitch;
        // 轻重的呼吸：起句平、中段饱满、收尾放轻
        let uVol = base.volume + (last ? -1 : (ci === 0 ? 0 : 2));
        let uNote = segNote;
        if (unit.weight === 2) { uRate *= 0.88; uPitch += 4; uVol += 5; uNote = `重音｜${uNote}`; }
        else if (unit.weight === 0) { uRate *= 1.06; uPitch -= 3; uVol -= 4; uNote = `轻声｜${uNote}`; }
        segs.push({
          sentence: unit.text.trim(),
          rate: Math.round(uRate * 100) / 100,
          pitch: Math.max(-35, Math.min(45, Math.round(uPitch))),
          volume: Math.max(-12, Math.min(12, Math.round(uVol))),
          note: uNote,
          pause: Math.round((unitLast ? pause : 0.04) * 100) / 100,
          sIdx: i,
        });
      }
    }
  }
};

const planProsody = (text, mood, gran = 'clause') => {
  const segs = [];
  // 情绪标记优先于一切：写文本的那位已经读懂了这段的感情，照标记演
  for (const run of splitMoodRuns(text)) planRunInto(run, mood, gran, segs);

  // ── 人格化装饰：傲娇的口是心非摇摆（按「句」摇摆，不按小句）─────────
  if (mood === 'tsundere') {
    for (const seg of segs) {
      if (seg.sIdx % 2 === 0) {
        // 「凶」句：又快又冲，音调拔高，停顿收短（像赌气甩话）
        seg.rate *= 1.12;
        seg.pitch += 16;
        seg.pause = Math.round(seg.pause * 0.7 * 100) / 100;
        seg.note = '傲娇·凶｜' + seg.note;
      } else {
        // 「软」句：突然放慢放低，像凶完又心软（才、才没有那个意思……）
        seg.rate *= 0.82;
        seg.pitch -= 12;
        seg.pause = Math.round(seg.pause * 1.3 * 100) / 100;
        seg.note = '傲娇·软｜' + seg.note;
      }
    }
  }

  // ── 人格化装饰：撒娇的拖长尾音 ─────────────────────────────────────
  if (mood === 'sajiao') {
    for (const seg of segs) {
      // 句尾语气词拖成波浪长音：啦→啦～～、嘛→嘛～～、呀/哦/喔/哎/嘿同理
      seg.sentence = seg.sentence.replace(/([啦嘛呀哦喔哎嘿呦欸])([。！？!?…]*)$/u, '$1～～$2');
      // 拖音句再放慢一点、调子抬高一点，念出来自然带嗲
      if (seg.sentence.includes('～～')) {
        seg.rate *= 0.88;
        seg.pitch += 6;
        seg.note = '撒娇拖音｜' + seg.note;
      }
    }
  }

  // ── 人格化装饰：害羞的轻轻放掉（嘛→嘛～，句尾收着点）──────────────
  if (mood === 'shy') {
    for (const seg of segs) {
      if (/[嘛呢啦哦呀][。！？!?…～]*$/u.test(seg.sentence)) {
        seg.sentence = seg.sentence.replace(/([嘛呢啦哦呀])([。！？!?…]*)$/u, '$1～$2');
        seg.rate *= 0.93;
        seg.note = '害羞软尾｜' + seg.note;
      }
    }
  }

  return segs;
};

/** 台本解析（drama 用）：「角色：台词」一行一句；空行是换场；没写角色名的行算旁白。 */
const parseDrama = (text) => {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (out.length > 0 && out[out.length - 1].scene !== true) out.push({ scene: true });
      continue;
    }
    const m = /^([^：:]{1,12})[：:]\s*(.*)$/u.exec(line);
    if (m !== null && m[2].trim() !== '') out.push({ speaker: m[1].trim(), line: m[2] });
    else out.push({ speaker: null, line });
  }
  while (out.length > 0 && out[out.length - 1].scene === true) out.pop();
  return out;
};

/** 角色发嗓：--cast "妹妹=zh-CN-XiaoyiNeural;哥哥=zh-CN-YunxiNeural"（值也可以是克隆音色名）。 */
const parseCast = (spec) => {
  const cast = {};
  for (const pair of String(spec).split(/[;；]/u)) {
    const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/u.exec(pair);
    if (m !== null) cast[m[1]] = m[2];
  }
  return cast;
};

/** sleep 助手（句间呼吸用）。注意：绝不能 unref()——await 一个已 unref 的
 *  定时器时，事件循环里没有别的活，Node 会直接静默退出，后面的句子全丢。 */
const nap = (seconds) => new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, seconds) * 1000);
});

/** say 引擎：逐句调用 say（内嵌 [[rate]]/[[pitch]]），句间真停顿「喘气」。 */
const speakSay = async (plan, voice, dryRun) => {
  // say 的 [[pitch]] 单位约 0-100（默认 50），[[rate]] 是 wpm
  const wpm = 200;
  if (dryRun) {
    for (const seg of plan) console.log(`  [${seg.note}] rate=${(seg.rate).toFixed(2)} pitch=${seg.pitch >= 0 ? '+' : ''}${seg.pitch} pause=${seg.pause}s  ${seg.sentence.slice(0, 40)}${seg.sentence.length > 40 ? '…' : ''}`);
    console.log(`(say 引擎，音色 ${voice ?? '系统默认'})`);
    return;
  }
  const args = voice ? ['-v', voice] : [];
  console.log(`朗读中（say · ${voice ?? '系统默认'}，${plan.length} 句，带停顿）…`);
  for (const [i, seg] of plan.entries()) {
    const rateWpm = Math.round(wpm * seg.rate);
    const pitchVal = Math.max(0, Math.min(100, 50 + seg.pitch));
    try {
      execFileSync('say', [...args, `[[rate ${rateWpm}]][[pitch ${pitchVal}]]${seg.sentence}`], { stdio: 'ignore' });
    } catch { process.exit(2); } // 被 stop 杀掉或失败都直接收场
    // 最后一句不用再喘气
    if (i < plan.length - 1 && seg.pause > 0) await nap(seg.pause);
  }
  console.log('朗读完毕');
};

/** edge 引擎：逐小句合成 mp3 并**边合成边放**（放这句的同时合成下一句，长文
 *  不用干等全篇合成完才开口）。每小句自带 rate/pitch/volume，连起来就是语调弧线。 */
const speakEdge = async (plan, voice, rateArg, dryRun, quiet = false) => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  // edge 的 rate/volume 是 ±%，pitch 是 Hz；--rate 参数是整体基调（如 +10%），逐句再叠乘
  const basePct = typeof rateArg === 'string' && /%$/.test(rateArg) ? Number(rateArg.replace('%', '')) || 0 : 0;
  const synthFile = (i, seg) => {
    const pct = Math.round(basePct + (seg.rate - 1) * 100);
    const volPct = Math.round(seg.volume ?? 0);
    const file = join(TMP_DIR, `${String(i).padStart(3, '0')}.mp3`);
    process.stderr.write(`\r合成中 ${i + 1}/${plan.length}…`);
    execFileSync(EDGE_BIN, [
      '--voice', voice,
      `--rate=${pct >= 0 ? '+' : ''}${pct}%`,
      `--pitch=${seg.pitch >= 0 ? '+' : ''}${seg.pitch}Hz`,
      `--volume=${volPct >= 0 ? '+' : ''}${volPct}%`,
      '--text', seg.sentence,
      '--write-media', file,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return existsSync(file) ? file : null;
  };

  if (dryRun) {
    for (const seg of plan) {
      const pct = Math.round(basePct + (seg.rate - 1) * 100);
      const volPct = Math.round(seg.volume ?? 0);
      console.log(`  [${seg.note}] rate=${pct >= 0 ? '+' : ''}${pct}% pitch=${seg.pitch >= 0 ? '+' : ''}${seg.pitch}Hz vol=${volPct >= 0 ? '+' : ''}${volPct}% pause=${seg.pause}s  ${seg.sentence.slice(0, 40)}${seg.sentence.length > 40 ? '…' : ''}`);
    }
    console.log(`(edge 引擎，音色 ${voice})`);
    return;
  }
  if (plan.length === 0) { console.error('edge：没有可念的句子'); process.exit(2); }
  if (!quiet) console.log(`朗读中（edge 神经语音 · ${voice}，${plan.length} 句，边合成边念）…`);
  // 边合成边放：下一句的合成与这一句的播放重叠；被 stop 杀掉就收场
  let pending = synthFile(0, plan[0]);
  for (const [i, seg] of plan.entries()) {
    const file = pending;
    pending = i + 1 < plan.length ? synthFile(i + 1, plan[i + 1]) : null;
    if (file === null) continue;
    const child = spawn('afplay', [file], { stdio: 'ignore' });
    const finished = await new Promise((resolve) => {
      child.on('error', () => resolve(false));
      child.on('exit', (code, signal) => resolve(signal == null));
    });
    if (!finished) break; // 被 pkill 或起不来，直接收场
    if (i < plan.length - 1 && seg.pause > 0) await nap(seg.pause); // 句间呼吸
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (!quiet) console.log('朗读完毕');
};

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (cmd === 'voices') {
    const voices = listVoices();
    const preferred = pickDefaultSayVoice(voices);
    console.log(`# say 音色（* 为默认；edge 引擎音色用 --voice zh-CN-XiaoxiaoNeural 等 id）`);
    const rows = opts.lang
      ? [...voices.filter((v) => v.lang.startsWith(opts.lang)), ...voices.filter((v) => !v.lang.startsWith(opts.lang))]
      : voices;
    for (const v of rows) {
      const mark = v.name === preferred ? '*' : ' ';
      console.log(`${mark} ${v.name}\t${v.lang}\t${v.sample}`);
    }
    console.log(`# edge 引擎${edgeAvailable() ? '：可用' : '：未安装（venv 缺失）'}，默认 ${pickDefaultEdgeVoice()}`);
    const cv = cloneVoices();
    console.log(`# clone 引擎${cloneAvailable() ? '：可用' : '：未就绪'}，已注册音色：${cv.length > 0 ? cv.join(', ') : '（无）'}`);
    return;
  }

  if (cmd === 'clone-voice') {
    // node tts.mjs clone-voice --name xishi --audio /path/voice.wav --ref-text "参考音频台词原文"
    const get = (key) => {
      const i = rest.indexOf(key);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    registerCloneVoice(get('--name') ?? '', get('--audio') ?? '', get('--ref-text') ?? '');
    return;
  }

  if (cmd === 'set-voice') {
    const flags = { engine: undefined };
    let name = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--engine') flags.engine = rest[++i];
      else if (!rest[i].startsWith('--') && name === '') name = rest[i];
    }
    if (!name) { console.error('set-voice 需要音色名'); process.exit(1); }
    if (flags.engine === 'edge') saveConfig({ voiceEdge: name });
    else if (flags.engine === 'clone') saveConfig({ voiceClone: name });
    else saveConfig({ voiceSay: name });
    console.log(`已记住${flags.engine ? ` ${flags.engine}` : ''} 音色：${name}`);
    return;
  }

  if (cmd === 'set-mood') {
    const mood = rest.filter((a) => !a.startsWith('--'))[0];
    if (!mood || !(mood in MOODS)) { console.error(`set-mood 需要：${Object.keys(MOODS).join('|')}`); process.exit(1); }
    saveConfig({ mood });
    console.log(`默认情绪基调已设为 ${mood}`);
    return;
  }

  if (cmd === 'stop') {
    let killed = false;
    for (const name of ['say', 'afplay', 'edge-tts']) {
      try { execFileSync('pkill', ['-x', name]); killed = true; } catch {}
    }
    rmSync(TMP_DIR, { recursive: true, force: true });
    rmSync(PLAYBACK_FILE, { force: true }); // 令牌无条件清掉，别让朗读声一直等
    console.log(killed ? '已停止朗读' : '当前没有正在朗读的进程');
    return;
  }

  if (cmd === 'speak') {
    let text = opts.text.join(' ').trim();
    if (opts.file) text = readFileSync(opts.file, 'utf8').trim();
    if (text === '') text = (await readStdin()).trim();
    if (text === '') { console.error('没有可朗读的文本（传参、--file 或 stdin）'); process.exit(1); }

    const cleaned = cleanText(encodeMarks(text));
    if (cleaned === '') { console.error('净化后没有可念的内容'); process.exit(1); }

    const config = loadConfig();
    const mood = opts.mood && opts.mood in MOODS ? opts.mood : (config.mood in MOODS ? config.mood : 'auto');
    // 引擎优先级：显式 --engine > 显式 clone 音色名 > 配置的默认克隆音色（set-voice --engine clone
    // 设过就一直是主嗓） > edge > say
    const namedClone = opts.voice !== undefined && cloneVoices().includes(opts.voice);
    const defaultClone = typeof config.voiceClone === 'string' && cloneVoices().includes(config.voiceClone);
    const engine = opts.engine && ['edge', 'say', 'clone'].includes(opts.engine)
      ? opts.engine
      : (namedClone || (defaultClone && cloneAvailable()) ? 'clone' : (edgeAvailable() ? 'edge' : 'say'));

    // 出声互斥：真念（非 dry-run）先认领通道，起跑前留 0.7s 让别的嗓子收声，
    // 保证听感上「永远只有一个声音」。
    let release = () => {};
    if (!opts.dryRun) {
      release = claimPlayback(cleaned);
      await nap(0.7);
    }
    try {
      if (engine === 'clone') {
        if (!cloneAvailable()) { console.error('clone 引擎未就绪（缺 venv-f5 或音色库）'); process.exit(1); }
        const voice = opts.voice ?? config.voiceClone ?? cloneVoices()[0];
        if (!voice) { console.error('没有注册过克隆音色：node tts.mjs clone-voice --name xx --audio xx --ref-text "…"'); process.exit(1); }
        // 克隆嗓整句合成：它自带真人的起承转合，切碎反而跳调
        const plan = planProsody(cleaned, mood, 'sentence');
        await speakClone(plan, voice, opts.dryRun);
        return;
      }
      if (engine === 'edge') {
        const voice = opts.voice ?? pickDefaultEdgeVoice();
        const plan = planProsody(cleaned, mood);
        await speakEdge(plan, voice, opts.rate, opts.dryRun);
        return;
      }
      const voices = listVoices();
      const voice = opts.voice ?? pickDefaultSayVoice(voices);
      const plan = planProsody(cleaned, mood);
      await speakSay(plan, voice, opts.dryRun);
      return;
    } finally {
      release();
    }
  }

  if (cmd === 'drama') {
    // drama：AI 短剧式配音。台本每行「角色：台词」，空行换场；
    // 台词里照常用【情绪】【生气×2】**重音** *轻声*；--cast 给角色发嗓子。
    let text = opts.text.join(' ').trim();
    if (opts.file) text = readFileSync(opts.file, 'utf8').trim();
    if (text === '') text = (await readStdin()).trim();
    if (text === '') { console.error('drama 需要台本（--file 或 stdin）'); process.exit(1); }

    const cast = parseCast(opts.cast ?? '');
    const script = parseDrama(text);
    const mood = opts.mood && opts.mood in MOODS ? opts.mood : 'auto';
    const NARRATOR = '旁白';
    // 一场戏只认领一次出声通道（dry-run 不出声，不占）
    const release = opts.dryRun ? () => {} : claimPlayback(text);
    if (!opts.dryRun) await nap(0.7);
    try {
      let lastSpeaker = null;
      for (const entry of script) {
        if (entry.scene === true) { await nap(1.1); continue; } // 空行 = 换场
        if (lastSpeaker !== null && entry.speaker !== lastSpeaker) await nap(0.45); // 换人的气口
        lastSpeaker = entry.speaker;
        const who = entry.speaker ?? NARRATOR;
        const voiceName = cast[who] ?? cast[NARRATOR] ?? pickDefaultEdgeVoice();
        const cleaned = cleanText(encodeMarks(entry.line));
        if (cleaned === '') continue;
        const isClone = cloneVoices().includes(voiceName);
        const plan = planProsody(cleaned, mood, isClone ? 'sentence' : 'clause');
        if (opts.dryRun) {
          console.log(`—— ${who}（${voiceName}${isClone ? ' · 克隆嗓' : ''}）——`);
          if (isClone) await speakClone(plan, voiceName, true);
          else await speakEdge(plan, voiceName, opts.rate, true);
          continue;
        }
        if (isClone) await speakClone(plan, voiceName, false, true);
        else await speakEdge(plan, voiceName, opts.rate, false, true);
      }
      if (!opts.dryRun) console.log('这场戏，念完了');
    } finally {
      release();
    }
    return;
  }

  if (cmd === 'render') {
    // render：合成到 wav 文件而不播放（插件 Host 预合成用；--out 必填）
    let text = opts.text.join(' ').trim();
    if (opts.file) text = readFileSync(opts.file, 'utf8').trim();
    if (text === '') text = (await readStdin()).trim();
    if (text === '') { console.error('render 需要文本'); process.exit(1); }
    if (!opts.out) { console.error('render 需要 --out <文件.wav>'); process.exit(1); }
    const config = loadConfig();
    const mood = opts.mood && opts.mood in MOODS ? opts.mood : (config.mood in MOODS ? config.mood : 'auto');
    const voice = opts.voice ?? config.voiceClone ?? cloneVoices()[0];
    if (!voice || !cloneVoices().includes(voice)) { console.error('render 只支持克隆音色（--voice <已注册音色>）'); process.exit(1); }
    const cleaned = cleanText(encodeMarks(text)).slice(0, 1500); // 预合成限长，超长截断防 CPU 长跑
    if (cleaned === '') { console.error('净化后没有可念的内容'); process.exit(1); }
    const plan = planProsody(cleaned, mood, 'sentence');
    const out = renderClone(plan, voice, opts.out);
    console.log(out); // stdout 只打路径，调用方好取
    return;
  }

  usage();
  process.exit(1);
};

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(2); });
