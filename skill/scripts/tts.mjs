#!/usr/bin/env node
/**
 * tts.mjs — 朗读（Read Aloud）脚本，dsh-tts-reader skill 的朗读半边。
 *
 * 两个引擎，自动选择：
 *   edge — 微软 Edge 神经语音（venv 里的 edge-tts，需联网），自然、有起伏
 *   say  — macOS 原生 say（完全离线兜底；Premium/Enhanced 音色也较自然）
 *
 * 情绪与韵律：
 *   --mood happy/sad/excited/calm/angry  整体基调（rate/pitch/volume 偏移）
 *   逐句自动调制：问句升调、感叹句提速提调、省略号放慢降调、
 *   长句中段轻微降速 —— 让平文本念出人味。
 *
 * 用法：
 *   node tts.mjs voices [--lang zh]          列出可用音色（* 为当前默认）
 *   node tts.mjs speak [options] [text...]   朗读（文本参数缺省时读 stdin）
 *     --engine auto|edge|say   默认 auto（edge 可用则用 edge）
 *     --voice <name>           音色（edge 用 zh-CN-XiaoxiaoNeural 这类 id；say 用系统音色名）
 *     --mood <基调>            calm|happy|sad|excited|angry（默认 calm）
 *     --rate <wpm 或 ±%>       say 用 wpm（默认 200）；edge 用 ±%（如 +10%）
 *     --file <path>            从文件读取要朗读的文本（utf-8）
 *     --dry-run                只打印逐句韵律计划，不朗读
 *   node tts.mjs stop                           停止当前朗读（含 afplay）
 *   node tts.mjs set-voice <name> [--engine]    记住默认音色
 *   node tts.mjs set-mood <mood>                记住默认情绪基调
 *
 * 退出码：0 成功；1 用法/环境错误；2 朗读失败。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
    const items = [];
    for (const [i, seg] of plan.entries()) {
      const raw = join(work, `s${i}.wav`);
      execFileSync(F5_PY, [
        bridge, '--ref', ref, '--ref-text', refText,
        '--text', seg.sentence, '--out', raw, '--estimate-duration',
        ...(seg.rate !== 1 ? ['--speed', seg.rate.toFixed(2)] : []),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      const norm = join(work, `n${i}.wav`);
      execFileSync(FFMPEG, ['-y', '-i', raw, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', norm], { stdio: ['ignore', 'ignore', 'pipe'] });
      items.push({ file: norm, pause: i < plan.length - 1 ? Math.round(seg.pause * 20) / 20 : 0 });
    }
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
const speakClone = async (plan, voiceName, dryRun) => {
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
  console.log(`克隆朗读中（${voiceName} · F5，${plan.length} 句，逐句合成约 ${plan.length * 15}s，念得慢但像哦）…`);
  for (const [i, seg] of plan.entries()) {
    const file = join(TMP_DIR, `${String(i).padStart(3, '0')}.wav`);
    process.stderr.write(`\r合成中 ${i + 1}/${plan.length}…`);
    try {
      execFileSync(F5_PY, [
        bridge,
        '--ref', ref,
        '--ref-text', refText,
        '--text', seg.sentence,
        '--out', file,
        '--estimate-duration', // 中文必须：默认时长预测器严重偏短
        ...(seg.rate !== 1 ? ['--speed', seg.rate.toFixed(2)] : []),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      console.error(`\n第 ${i + 1} 句合成失败：${String(error?.message ?? error).slice(0, 300)}`);
      process.exit(2);
    }
    process.stderr.write('\r播放中 ' + ' '.repeat(20) + '\r');
    try {
      execFileSync('afplay', [file], { stdio: 'ignore' });
    } catch { break; } // 被 stop 杀掉
    if (i < plan.length - 1 && seg.pause > 0) await nap(seg.pause);
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('克隆朗读完毕');
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

// ── 情绪基调：rate/pitch/volume 的整体偏移 ─────────────────────────────
const MOODS = {
  calm:     { rate: 0.00, pitch: 0,  volume: 0 },
  happy:    { rate: 0.08, pitch: 12, volume: 3 },
  excited:  { rate: 0.18, pitch: 22, volume: 6 },
  sad:      { rate: -0.12, pitch: -10, volume: -5 },
  angry:    { rate: 0.10, pitch: -4, volume: 8 },
  // 傲娇：一句凶一句软地摇摆（见 planProsody 装饰），整体偏快偏高
  tsundere: { rate: 0.02, pitch: 4, volume: 3 },
  // 撒娇：整体放慢，尾音拖长（好啦 → 好啦～～）
  sajiao:   { rate: -0.18, pitch: 14, volume: -3 },
};

const usage = () => {
  console.error(`用法：
  node tts.mjs voices [--lang zh]        列出 say 可用音色（* 为当前默认）
  node tts.mjs speak [options] [text]    朗读；文本缺省时读 stdin
      --engine auto|edge|say|clone  默认 auto（指定 clone 音色名时自动用 clone）
      --voice <name>           音色（clone: 注册名；edge: zh-CN-XiaoxiaoNeural；say: 系统音色名）
      --mood calm|happy|sad|excited|angry|tsundere|sajiao   情绪基调（默认 calm）
      --rate <wpm 或 ±%>       say: wpm（默认 200）；edge: ±%
      --file <path>            从 utf-8 文件读取文本
      --dry-run                只打印韵律计划
  node tts.mjs stop                          停止朗读
  node tts.mjs set-voice <name> [--engine say|edge|clone]   记住音色
  node tts.mjs set-mood <mood>               记住情绪基调
  node tts.mjs clone-voice --name <id> --audio <音频> --ref-text "<参考音频台词>"
      注册 F5 克隆音色（任意格式音频自动转 24kHz；台词必须与音频内容一致）`);
};

const parseArgs = (argv) => {
  const opts = { text: [], voice: undefined, rate: undefined, file: undefined, lang: 'zh', dryRun: false, engine: undefined, mood: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--rate') opts.rate = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
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
  .replace(/[#*_`~>|\\-]+/g, ' ')
  .replace(/[《》【】「」『』·—…☆★♪]+/g, (m) => (m.includes('…') ? '……' : ''))
  .replace(/[ \t]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')      // 行内换行保留为段落线索
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/**
 * 逐句切分并标注韵律与「呼吸」。先按空行分段，段内再按句末标点切句：
 *   段落结束   —— 停 0.9 秒（大喘气，换段落的感觉）
 *   ？句尾     —— 停 0.4 秒 + 升调（等回应的停顿）
 *   ！句尾     —— 停 0.25 秒 + 提速提调
 *   ……结尾     —— 停 0.7 秒 + 放慢降调（意味深长）
 *   陈述句尾   —— 停 0.3 秒
 *   超过 40 字的长句 —— 轻微降速（喘口气）
 * 基调 mood 在此之上整体偏移，并微调停顿长短（sad 慢半拍、excited 紧凑）。
 * 两种「人格化」基调在逐句结果上再做装饰：
 *   tsundere 傲娇 —— 奇数句又凶又快（高调+提速），偶数句突然放软（降调+放慢），
 *                    像「才、才没有特意……哼！」那种口是心非的摇摆
 *   sajiao   撒娇 —— 句尾语气词拖长（啦→啦～～、嘛→嘛～～），整体更慢更嗲
 */
const planProsody = (text, mood) => {
  const base = MOODS[mood] ?? MOODS.calm;
  const pauseScale = { calm: 1.0, happy: 0.9, excited: 0.65, sad: 1.25, angry: 0.8, tsundere: 0.85, sajiao: 1.15 }[mood] ?? 1.0;
  const paragraphs = String(text).split(/\n+/).map((p) => p.trim()).filter((p) => p !== '');
  const segs = [];
  for (const [pi, para] of paragraphs.entries()) {
    const isLastPara = pi === paragraphs.length - 1;
    const parts = para.split(/(?<=[。！？!?…])(?=\s*[^。！？!?…]|$)/u).filter((s) => s.trim() !== '');
    for (const [si, raw] of parts.entries()) {
      const sentence = raw.trim();
      let rate = 1 + base.rate;
      let pitch = base.pitch;
      let pause = 0.3;
      let note = '陈述';
      if (/[？?][”"』」)]*\s*$/u.test(sentence)) { rate *= 0.97; pitch += 14; pause = 0.4; note = '问句升调'; }
      else if (/[！!][”"』」)]*\s*$/u.test(sentence)) { rate *= 1.08; pitch += 8; pause = 0.25; note = '感叹提速'; }
      else if (/…{1,2}\s*$/u.test(sentence)) { rate *= 0.85; pitch -= 8; pause = 0.7; note = '省略号放慢'; }
      else if (sentence.length > 40) { rate *= 0.93; note = '长句降速'; }
      const paraEnd = si === parts.length - 1;
      if (paraEnd && !isLastPara) { pause = 0.9; note += '｜段间大喘气'; }
      segs.push({ sentence, rate, pitch, note, pause: Math.round(pause * pauseScale * 100) / 100 });
    }
  }

  // ── 人格化装饰：傲娇的口是心非摇摆 ─────────────────────────────────
  if (mood === 'tsundere') {
    for (const [i, seg] of segs.entries()) {
      if (i % 2 === 0) {
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

  return segs;
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

/** edge 引擎：逐句合成 mp3（每句单独调 rate/pitch），再按序 afplay。 */
const speakEdge = async (plan, voice, rateArg, dryRun) => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  const files = [];
  for (const [i, seg] of plan.entries()) {
    // edge 的 rate 是 ±%；--rate 参数是整体基调（如 +10%），逐句再叠乘
    const basePct = typeof rateArg === 'string' && /%$/.test(rateArg) ? Number(rateArg.replace('%', '')) || 0 : 0;
    const pct = Math.round(basePct + (seg.rate - 1) * 100);
    const pitchHz = seg.pitch; // edge 的 pitch 单位是 Hz，正值升调负值降调
    const file = join(TMP_DIR, `${String(i).padStart(3, '0')}.mp3`);
    if (dryRun) {
      console.log(`  [${seg.note}] rate=${pct >= 0 ? '+' : ''}${pct}% pitch=${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz pause=${seg.pause}s  ${seg.sentence.slice(0, 40)}${seg.sentence.length > 40 ? '…' : ''}`);
      continue;
    }
    process.stderr.write(`\r合成中 ${i + 1}/${plan.length}…`);
    execFileSync(EDGE_BIN, [
      '--voice', voice,
      `--rate=${pct >= 0 ? '+' : ''}${pct}%`,
      `--pitch=${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
      '--text', seg.sentence,
      '--write-media', file,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (existsSync(file)) files.push(file);
  }
  if (dryRun) { console.log(`(edge 引擎，音色 ${voice})`); return; }
  process.stderr.write('\n');
  if (files.length === 0) { console.error('edge 合成失败（无输出文件）'); process.exit(2); }
  console.log(`朗读中（edge 神经语音 · ${voice}，${files.length} 句，逐句带情绪起伏与停顿）…`);
  // 顺序播放，句间按计划停顿「喘气」，直到放完或被 stop 杀掉
  for (const [i, file] of files.entries()) {
    if (!existsSync(file)) break; // stop 清理过临时目录
    try {
      execFileSync('afplay', [file], { stdio: 'ignore' });
    } catch { break; } // 被 pkill 或失败都直接收场
    if (i < files.length - 1 && plan[i]?.pause > 0) await nap(plan[i].pause);
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('朗读完毕');
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
    console.log(killed ? '已停止朗读' : '当前没有正在朗读的进程');
    return;
  }

  if (cmd === 'speak') {
    let text = opts.text.join(' ').trim();
    if (opts.file) text = readFileSync(opts.file, 'utf8').trim();
    if (text === '') text = (await readStdin()).trim();
    if (text === '') { console.error('没有可朗读的文本（传参、--file 或 stdin）'); process.exit(1); }

    const cleaned = cleanText(text);
    if (cleaned === '') { console.error('净化后没有可念的内容'); process.exit(1); }

    const config = loadConfig();
    const mood = opts.mood && opts.mood in MOODS ? opts.mood : (config.mood in MOODS ? config.mood : 'calm');
    // 引擎优先级：显式 --engine > 显式 clone 音色名 > 配置的默认克隆音色（set-voice --engine clone
    // 设过就一直是主嗓） > edge > say
    const namedClone = opts.voice !== undefined && cloneVoices().includes(opts.voice);
    const defaultClone = typeof config.voiceClone === 'string' && cloneVoices().includes(config.voiceClone);
    const engine = opts.engine && ['edge', 'say', 'clone'].includes(opts.engine)
      ? opts.engine
      : (namedClone || (defaultClone && cloneAvailable()) ? 'clone' : (edgeAvailable() ? 'edge' : 'say'));

    if (engine === 'clone') {
      if (!cloneAvailable()) { console.error('clone 引擎未就绪（缺 venv-f5 或音色库）'); process.exit(1); }
      const voice = opts.voice ?? config.voiceClone ?? cloneVoices()[0];
      if (!voice) { console.error('没有注册过克隆音色：node tts.mjs clone-voice --name xx --audio xx --ref-text "…"'); process.exit(1); }
      const plan = planProsody(cleaned, mood);
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
  }

  if (cmd === 'render') {
    // render：合成到 wav 文件而不播放（插件 Host 预合成用；--out 必填）
    let text = opts.text.join(' ').trim();
    if (opts.file) text = readFileSync(opts.file, 'utf8').trim();
    if (text === '') text = (await readStdin()).trim();
    if (text === '') { console.error('render 需要文本'); process.exit(1); }
    if (!opts.out) { console.error('render 需要 --out <文件.wav>'); process.exit(1); }
    const config = loadConfig();
    const mood = opts.mood && opts.mood in MOODS ? opts.mood : (config.mood in MOODS ? config.mood : 'calm');
    const voice = opts.voice ?? config.voiceClone ?? cloneVoices()[0];
    if (!voice || !cloneVoices().includes(voice)) { console.error('render 只支持克隆音色（--voice <已注册音色>）'); process.exit(1); }
    const cleaned = cleanText(text).slice(0, 1500); // 预合成限长，超长截断防 CPU 长跑
    if (cleaned === '') { console.error('净化后没有可念的内容'); process.exit(1); }
    const plan = planProsody(cleaned, mood);
    const out = renderClone(plan, voice, opts.out);
    console.log(out); // stdout 只打路径，调用方好取
    return;
  }

  usage();
  process.exit(1);
};

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(2); });
