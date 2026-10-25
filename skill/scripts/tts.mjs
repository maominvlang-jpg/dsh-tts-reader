#!/usr/bin/env node
/**
 * tts.mjs — 朗读（Read Aloud）脚本，dsh-tts-reader skill 的朗读半边。
 *
 * 用 macOS 原生 `say` 把文本念出来：完全本机、离线、不上传。
 * 与插件版不同，这里由 Agent 直接驱动，因此支持从 stdin / 文件读长文本、
 * 指定音色、停止朗读、以及把音色偏好持久化。
 *
 * 用法：
 *   node tts.mjs voices [--lang zh]          列出可用音色（默认先列中文）
 *   node tts.mjs speak [options] [text...]   朗读（文本参数缺省时读 stdin）
 *     --voice <name>   音色名（默认用 config.json 里的 voice，或自动挑中文音色）
 *     --rate <wpm>     语速（words per minute，默认 200，婷婷约 150-250 自然）
 *     --file <path>    从文件读取要朗读的文本（utf-8）
 *     --dry-run        只打印将要执行的命令与文本预览，不真的念
 *   node tts.mjs stop                       停止当前朗读
 *   node tts.mjs set-voice <name>           记住默认音色（写入 config.json）
 *
 * 退出码：0 成功；1 用法/环境错误；2 朗读失败。
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.dsh', 'dsh-tts-reader');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const loadConfig = () => {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
};

const saveVoice = (voice) => {
  const merged = { ...loadConfig(), voice };
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

const pickDefaultVoice = (voices) => {
  const saved = loadConfig().voice;
  if (typeof saved === 'string' && voices.some((v) => v.name === saved)) return saved;
  // 中文优先：增强版 Siri 声音 > 婷婷 > 任意 zh_CN > 系统默认
  const zh = voices.filter((v) => v.lang.startsWith('zh'));
  const enhanced = zh.find((v) => /\(Enhanced\)|Siri/i.test(v.name));
  if (enhanced) return enhanced.name;
  const tiantian = zh.find((v) => /Tiantian/i.test(v.name));
  if (tiantian) return tiantian.name;
  const tingting = zh.find((v) => /Tingting/i.test(v.name));
  if (tingting) return tingting.name;
  if (zh.length > 0) return zh[0].name;
  return undefined; // 让 say 用系统默认
};

const usage = () => {
  console.error(`用法：
  node tts.mjs voices [--lang zh]        列出可用音色（* 为当前默认）
  node tts.mjs speak [options] [text]    朗读；文本缺省时读 stdin
      --voice <name>  音色（默认取 config.json，或自动挑中文音色）
      --rate <wpm>    语速（默认 200）
      --file <path>   从 utf-8 文件读取文本
      --dry-run       只打印命令与文本预览
  node tts.mjs stop                      停止朗读
  node tts.mjs set-voice <name>          记住默认音色`);
};

const parseArgs = (argv) => {
  const opts = { text: [], voice: undefined, rate: undefined, file: undefined, lang: 'zh', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--voice') opts.voice = argv[++i];
    else if (a === '--rate') opts.rate = Number(argv[++i]);
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
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
  // 没有管道输入时不要挂死
  if (process.stdin.isTTY) resolve(data);
});

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (cmd === 'voices') {
    const voices = listVoices();
    const preferred = pickDefaultVoice(voices);
    const rows = opts.lang
      ? [...voices.filter((v) => v.lang.startsWith(opts.lang)), ...voices.filter((v) => !v.lang.startsWith(opts.lang))]
      : voices;
    for (const v of rows) {
      const mark = v.name === preferred ? '*' : ' ';
      console.log(`${mark} ${v.name}\t${v.lang}\t${v.sample}`);
    }
    return;
  }

  if (cmd === 'set-voice') {
    const name = rest.filter((a) => !a.startsWith('--'))[0];
    if (!name) { console.error('set-voice 需要音色名'); process.exit(1); }
    saveVoice(name);
    console.log(`默认音色已设为 ${name}`);
    return;
  }

  if (cmd === 'stop') {
    // say 以进程名运行，直接按名终止
    try { execFileSync('pkill', ['-x', 'say']); console.log('已停止朗读'); }
    catch { console.log('当前没有正在朗读的进程'); }
    return;
  }

  if (cmd === 'speak') {
    let text = opts.text.join(' ').trim();
    if (opts.file) text = readFileSync(opts.file, 'utf8').trim();
    if (text === '') text = (await readStdin()).trim();
    if (text === '') { console.error('没有可朗读的文本（传参、--file 或 stdin）'); process.exit(1); }

    // 内容净化：markdown 标记、网址、装饰符号不念（与插件版一致的原则）
    const cleaned = text
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*/g, '')) // 代码块：去围栏、保留正文
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')                       // 链接/图片：保留文字
      .replace(/https?:\/\/\S+/g, '')                                  // 网址不念
      .replace(/[#*_`~>|\\-]+/g, ' ')                                  // markdown 记号
      .replace(/[《》【】「」『』·—…☆★♪]+/g, '')                          // 装饰符号
      .replace(/\s+/g, ' ')
      .trim();

    const voices = listVoices();
    const voice = opts.voice ?? pickDefaultVoice(voices);
    const args = [];
    if (voice) args.push('-v', voice);
    if (Number.isFinite(opts.rate) && opts.rate > 0) args.push('-r', String(Math.round(opts.rate)));

    if (opts.dryRun) {
      console.log('[dry-run] say', args.join(' '), '\n[text]', cleaned.slice(0, 200), cleaned.length > 200 ? '…' : '');
      return;
    }
    console.log(`朗读中（音色 ${voice ?? '系统默认'}，${cleaned.length} 字）…`);
    // say 前台阻塞直到念完；长文本自动断句由 say 处理
    const child = spawn('say', [...args, cleaned], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code === 0 ? 0 : 2));
    return;
  }

  usage();
  process.exit(1);
};

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(2); });
