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

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.dsh', 'dsh-tts-reader');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const TMP_DIR = join(CONFIG_DIR, 'tts-tmp');
const EDGE_BIN = join(CONFIG_DIR, 'venv', 'bin', 'edge-tts');

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
  calm:   { rate: 0.00, pitch: 0,  volume: 0 },
  happy:  { rate: 0.08, pitch: 12, volume: 3 },
  excited:{ rate: 0.18, pitch: 22, volume: 6 },
  sad:    { rate: -0.12, pitch: -10, volume: -5 },
  angry:  { rate: 0.10, pitch: -4, volume: 8 },
};

const usage = () => {
  console.error(`用法：
  node tts.mjs voices [--lang zh]        列出 say 可用音色（* 为当前默认）
  node tts.mjs speak [options] [text]    朗读；文本缺省时读 stdin
      --engine auto|edge|say   默认 auto（edge 可用则用 edge）
      --voice <name>           音色（edge: zh-CN-XiaoxiaoNeural；say: 系统音色名）
      --mood calm|happy|sad|excited|angry   情绪基调（默认 calm）
      --rate <wpm 或 ±%>       say: wpm（默认 200）；edge: ±%
      --file <path>            从 utf-8 文件读取文本
      --dry-run                只打印韵律计划
  node tts.mjs stop                          停止朗读
  node tts.mjs set-voice <name> [--engine say|edge]   记住音色
  node tts.mjs set-mood <mood>               记住情绪基调`);
};

const parseArgs = (argv) => {
  const opts = { text: [], voice: undefined, rate: undefined, file: undefined, lang: 'zh', dryRun: false, engine: undefined, mood: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--rate') opts.rate = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--engine') opts.engine = argv[++i];
    else if (a === '--mood') opts.mood = argv[++i];
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

/** 内容净化（与插件版一致的原则）。 */
const cleanText = (text) => text
  .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*/g, ''))
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/[#*_`~>|\\-]+/g, ' ')
  .replace(/[《》【】「」『』·—…☆★♪]+/g, (m) => (m.includes('…') ? '……' : ''))
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 逐句切分并标注韵律。每句得到 rate/pitch 的乘除偏移：
 *   ？句尾   —— 升调（疑问上扬）
 *   ！句尾   —— 提速提调（情绪释放）
 *   ……结尾  —— 放慢降调（意味深长）
 *   超过 40 字的长句中段 —— 轻微降速（喘气）
 * 基调 mood 在此之上整体偏移。
 */
const planProsody = (text, mood) => {
  const base = MOODS[mood] ?? MOODS.calm;
  // 按句末标点切（保留下一段的完整性）
  const parts = String(text).split(/(?<=[。！？!?…])(?=\s*[^。！？!?…]|$)/u).filter((s) => s.trim() !== '');
  return parts.map((raw) => {
    const sentence = raw.trim();
    let rate = 1 + base.rate;
    let pitch = base.pitch;
    let note = '';
    if (/[？?][”"』」)]*\s*$/u.test(sentence)) { rate *= 0.97; pitch += 14; note = '问句升调'; }
    else if (/[！!][”"』」)]*\s*$/u.test(sentence)) { rate *= 1.08; pitch += 8; note = '感叹提速'; }
    else if (/…{1,2}\s*$/u.test(sentence)) { rate *= 0.85; pitch -= 8; note = '省略号放慢'; }
    else if (sentence.length > 40) { rate *= 0.93; note = '长句降速'; }
    else { note = '陈述'; }
    return { sentence, rate, pitch, note };
  });
};

/** say 引擎：内嵌 [[rate]]/[[pitch]] 逐句控制。 */
const speakSay = (plan, voice, dryRun) => {
  // say 的 [[pitch]] 单位约 0-100（默认 50），[[rate]] 是 wpm
  const wpm = 200;
  let script = '';
  for (const seg of plan) {
    const rateWpm = Math.round(wpm * seg.rate);
    const pitchVal = Math.max(0, Math.min(100, 50 + seg.pitch));
    script += `[[rate ${rateWpm}]][[pitch ${pitchVal}]]${seg.sentence} `;
  }
  script = script.trim();
  if (dryRun) {
    for (const seg of plan) console.log(`  [${seg.note}] rate=${(seg.rate).toFixed(2)} pitch=${seg.pitch >= 0 ? '+' : ''}${seg.pitch}  ${seg.sentence.slice(0, 40)}${seg.sentence.length > 40 ? '…' : ''}`);
    console.log(`(say 引擎，音色 ${voice ?? '系统默认'})`);
    return;
  }
  const args = [];
  if (voice) args.push('-v', voice);
  console.log(`朗读中（say · ${voice ?? '系统默认'}，${plan.length} 句）…`);
  const child = spawn('say', [...args, script], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code === 0 ? 0 : 2));
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
      console.log(`  [${seg.note}] rate=${pct >= 0 ? '+' : ''}${pct}% pitch=${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz  ${seg.sentence.slice(0, 40)}${seg.sentence.length > 40 ? '…' : ''}`);
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
  console.log(`朗读中（edge 神经语音 · ${voice}，${files.length} 句，逐句带情绪起伏）…`);
  // 顺序播放，直到放完或被 stop 杀掉
  for (const file of files) {
    if (!existsSync(file)) continue; // stop 清理过临时目录
    try {
      execFileSync('afplay', [file], { stdio: 'ignore' });
    } catch { break; } // 被 pkill 或失败都直接收场
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
    else saveConfig({ voiceSay: name });
    console.log(`已记住${flags.engine === 'edge' ? ' edge' : ' say'} 音色：${name}`);
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
    const engine = opts.engine === 'edge' || opts.engine === 'say'
      ? opts.engine
      : (edgeAvailable() ? 'edge' : 'say');

    if (engine === 'edge') {
      const voice = opts.voice ?? pickDefaultEdgeVoice();
      const plan = planProsody(cleaned, mood);
      await speakEdge(plan, voice, opts.rate, opts.dryRun);
      return;
    }
    const voices = listVoices();
    const voice = opts.voice ?? pickDefaultSayVoice(voices);
    const plan = planProsody(cleaned, mood);
    speakSay(plan, voice, opts.dryRun);
    return;
  }

  usage();
  process.exit(1);
};

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(2); });
