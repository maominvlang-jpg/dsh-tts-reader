#!/usr/bin/env node
/**
 * song.mjs — 唱歌（AI Song Generation）脚本，dsh-tts-reader skill 的音乐半边。
 *
 * 与插件版完全同源的两套路由，但由 Agent 直接驱动：
 *   💻 本机（免费、离线）：mlx-serve 的 ACE-Step 端点（默认 http://127.0.0.1:8080）
 *   ☁️ 云端（可选）：任意 Suno 兼容中转 API（apiKey 存本机 config.json）
 *
 * 歌曲缓存目录与插件版一致：~/.dsh/dsh-tts-reader/songs/，历史 history.json。
 *
 * 用法：
 *   node song.mjs health                     检查本机引擎是否在线
 *   node song.mjs gen [options]              生成一首歌
 *     --style <text>       曲风/描述（必填其一）
 *     --lyrics <text>      歌词（留空 = 纯音乐；可传 --lyrics-file）
 *     --lyrics-file <path> 从 utf-8 文件读歌词
 *     --title <name>       歌名
 *     --duration <sec>     期望时长 10-600（本机默认 90；会按歌词量自动延长）
 *     --provider local|cloud  默认读 config.json（当前为 local）
 *     --wait               阻塞直到完成并打印输出文件路径（本机默认即阻塞）
 *   node song.mjs history [--tail N]         列出生成历史（默认 10 条）
 *   node song.mjs config set <k> <v>        写配置：apiKey/provider/localBase/localDuration 等
 *   node song.mjs config show               打印配置（apiKey 打码）
 *
 * 退出码：0 成功；1 用法/环境错误；2 生成失败。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const CONFIG_DIR = join(homedir(), '.dsh', 'dsh-tts-reader');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const SONGS_DIR = join(CONFIG_DIR, 'songs');
const HISTORY_FILE = join(CONFIG_DIR, 'history.json');
const HISTORY_LIMIT = 50;

const DEFAULT_BASE = 'https://api.sunoapi.org';
const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:8080';
const DEFAULT_LOCAL_MODEL = 'ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit';

const loadConfig = () => {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
};
const saveConfig = (patch) => {
  const merged = { ...loadConfig(), ...patch };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
};
const loadHistory = () => {
  try { const list = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(list) ? list : []; }
  catch { return []; }
};
const appendHistory = (entry) => {
  const list = loadHistory();
  list.unshift(entry);
  while (list.length > HISTORY_LIMIT) list.pop();
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(HISTORY_FILE, JSON.stringify(list), { mode: 0o600 });
};

/** 结构标签（[verse]/[chorus]…）原样保留；散文化歌词切成一行一句。 */
const LYRIC_STRUCTURE = /\[(verse|chorus|intro|outro|bridge|pre_chorus|hook)\]/i;
const preprocessLyrics = (text) => {
  if (!text) return '';
  if (LYRIC_STRUCTURE.test(text)) return text;
  const segments = String(text)
    .split(/[\n。！？!?；;，,、]+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const lines = [];
  for (const segment of segments) {
    if (segment.length <= 2 && lines.length > 0) lines[lines.length - 1] += segment;
    else lines.push(segment);
  }
  return lines.join('\n');
};

/** 中文歌词约 2.4s/字 + 10s 前奏；只延长不缩短，保证字不被吞。 */
const estimateLyricSeconds = (text) => {
  const chars = String(text).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').length;
  if (chars === 0) return 0;
  return Math.min(300, Math.ceil(chars * 2.4) + 10);
};
const fitDuration = (lyrics, requested) => {
  const estimate = estimateLyricSeconds(lyrics);
  if (estimate === 0) return requested;
  return Math.min(600, Math.max(requested, estimate));
};

/** 本机引擎调用：生成可能跑几十秒到几分钟，不设响应超时。 */
const engineCall = (url, payload) => new Promise((resolve, reject) => {
  const request = new URL(url);
  const lib = request.protocol === 'https:' ? import('node:https') : import('node:http');
  lib.then(({ request: req }) => {
    const body = JSON.stringify(payload);
    const r = req(request, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buffer: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(0);
    r.end(body);
  }).catch(reject);
});

const providerCall = async (config, path, init) => {
  const base = String(config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const res = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...(init?.headers ?? {}) },
    });
    let payload = null;
    try { payload = await res.json(); } catch {}
    return { status: res.status, payload };
  } catch (error) {
    return { status: 0, payload: { msg: String(error?.message ?? error) } };
  }
};

const parseArgs = (argv) => {
  const o = { style: '', lyrics: '', lyricsFile: '', title: '', duration: undefined, provider: undefined, wait: true, tail: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--style') o.style = argv[++i] ?? '';
    else if (a === '--lyrics') o.lyrics = argv[++i] ?? '';
    else if (a === '--lyrics-file') o.lyricsFile = argv[++i];
    else if (a === '--title') o.title = argv[++i] ?? '';
    else if (a === '--duration') o.duration = Number(argv[++i]);
    else if (a === '--provider') o.provider = argv[++i];
    else if (a === '--tail') o.tail = Number(argv[++i]);
    else if (a === '--no-wait') o.wait = false;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
};

const health = async () => {
  const config = loadConfig();
  const base = String(config.localBase || DEFAULT_LOCAL_BASE).replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    console.log(res.ok ? `本机引擎在线：${base} ${text.trim()}` : `本机引擎异常：HTTP ${res.status} ${text.slice(0, 200)}`);
    process.exit(res.ok ? 0 : 1);
  } catch (error) {
    console.error(`本机引擎无响应（${base}）：${String(error?.message ?? error)}\n启动命令：mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight`);
    process.exit(1);
  }
};

const genLocal = async (config, o) => {
  const base = String(config.localBase || DEFAULT_LOCAL_BASE).replace(/\/+$/, '');
  const lyrics = preprocessLyrics(o.lyrics);
  const requested = Number.isFinite(o.duration) && o.duration >= 10 && o.duration <= 600
    ? Math.round(o.duration)
    : (typeof config.localDuration === 'number' ? config.localDuration : 90);
  const duration = fitDuration(lyrics, requested);
  console.log(`本机生成：模型 ${config.localModel || DEFAULT_LOCAL_MODEL}，时长 ${duration}s，风格「${o.style || '纯音乐'}」…`);
  let result;
  try {
    result = await engineCall(`${base}/v1/audio/music-generations`, {
      model: config.localModel || DEFAULT_LOCAL_MODEL,
      prompt: o.style,
      lyrics,
      vocal_language: 'zh',
      duration_seconds: duration,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    console.error(/fetch failed|ECONNREFUSED|ECONNRESET/i.test(message)
      ? '本机引擎无响应：可能正在忙（稍等几秒重试），或未启动。启动命令：mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight'
      : message);
    process.exit(2);
  }
  if (!result.ok || result.buffer.length < 1024) {
    console.error(`mlx-serve HTTP ${result.status}：${result.buffer.toString('utf8').slice(0, 300)}`);
    process.exit(2);
  }
  mkdirSync(SONGS_DIR, { recursive: true, mode: 0o700 });
  const fileName = `local-${Date.now()}-${process.pid}.wav`;
  const filePath = join(SONGS_DIR, fileName);
  writeFileSync(filePath, result.buffer, { mode: 0o600 });
  appendHistory({ id: fileName, source: 'local', url: `/dsh-tts/local-song/${fileName}`, style: o.style, duration, createdAt: Date.now() });
  console.log(`✅ 生成完成：${filePath}（${(result.buffer.length / 1024 / 1024).toFixed(1)} MB, ${duration}s）`);
  console.log(`试听：afplay "${filePath}"`);
  return filePath;
};

const genCloud = async (config, o) => {
  const apiKey = config.apiKey;
  if (typeof apiKey !== 'string' || apiKey === '') {
    console.error('云端模式需要 apiKey：node song.mjs config set apiKey <你的Key>（或改用 --provider local 本机免费生成）');
    process.exit(1);
  }
  const payload = {
    customMode: true,
    instrumental: o.lyrics.trim() === '',
    model: /^(V6|V6_MINI|V6_WILD)$/.test(config.model ?? '') ? config.model : 'V6',
    lyrics: o.lyrics,
    style: o.style,
    ...(o.title ? { title: o.title } : {}),
  };
  const { status, payload: providerPayload } = await providerCall(config, '/api/v1/generate', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const taskId = providerPayload?.data?.taskId;
  if ((status !== 200 && status !== 201) || typeof taskId !== 'string') {
    console.error(`云端提交失败：HTTP ${status} code=${providerPayload?.code ?? '-'} msg=${providerPayload?.msg ?? providerPayload?.message ?? '-'}`);
    process.exit(2);
  }
  console.log(`已提交云端任务：${taskId}`);
  if (!o.wait) { console.log(`查询进度：node song.mjs gen … --wait（或手动 GET /api/v1/generate/record-info?taskId=${taskId}）`); return; }
  // 轮询直到 SUCCESS / 失败，5 分钟封顶
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const { status: st, payload: info } = await providerCall(config, `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' });
    if (st !== 200) { console.error(`查询失败：HTTP ${st}`); continue; }
    const data = info?.data ?? {};
    const tracks = (Array.isArray(data?.response?.sunoData) ? data.response.sunoData : [])
      .filter((t) => typeof t?.audio_url === 'string' && t.audio_url !== '')
      .map((t) => ({ title: t.title ?? '', url: t.audio_url, duration: t.duration ?? null }));
    process.stderr.write(`状态 ${data.status ?? 'UNKNOWN'}，已就绪 ${tracks.length} 轨\r`);
    if (tracks.length > 0) {
      appendHistory({ id: tracks[0].url, source: 'cloud', url: tracks[0].url, style: o.style, title: tracks[0].title, duration: tracks[0].duration, createdAt: Date.now() });
      console.log(`\n✅ 生成完成：`);
      for (const t of tracks) console.log(`  - ${t.title || '(未命名)'}  ${t.duration ?? '?'}s  ${t.url}`);
      return;
    }
    if (data.status === 'CREATE_TASK_FAILED' || data.status === 'GENERATE_AUDIO_FAILED') {
      console.error(`\n生成失败：${data.errorMessage ?? data.status}`); process.exit(2);
    }
  }
  console.error('\n轮询超时（5 分钟）'); process.exit(2);
};

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (o.help || cmd === undefined) {
    console.error('命令：health | gen --style … [--lyrics …] | history [--tail N] | config set/show\n详见文件头部注释或 SKILL.md');
    process.exit(cmd === undefined ? 1 : 0);
  }

  if (cmd === 'health') return health();

  if (cmd === 'gen') {
    if (o.style === '' && o.lyrics === '' && o.lyricsFile === undefined) {
      console.error('gen 需要 --style 或 --lyrics（两者皆空没有意义）'); process.exit(1);
    }
    if (o.lyricsFile) o.lyrics = readFileSync(o.lyricsFile, 'utf8');
    const config = loadConfig();
    const provider = o.provider ?? (config.provider === 'cloud' ? 'cloud' : 'local');
    return provider === 'local' ? genLocal(config, o) : genCloud(config, o);
  }

  if (cmd === 'history') {
    const list = loadHistory().slice(0, o.tail);
    if (list.length === 0) { console.log('（暂无历史）'); return; }
    for (const e of list) {
      const localName = typeof e.url === 'string' ? basename(e.url) : '';
      const exists = e.source === 'local' && localName ? existsSync(join(SONGS_DIR, localName)) : true;
      const size = exists && e.source === 'local' ? `${(statSync(join(SONGS_DIR, localName)).size / 1024 / 1024).toFixed(1)} MB` : (e.duration ? `${e.duration}s` : '');
      console.log(`${new Date(e.createdAt).toLocaleString('zh-CN')}\t[${e.source}] ${e.title || e.style || ''}\t${size}\t${exists ? e.url : '(文件已删除)'}${e.source === 'local' && exists ? `\n  试听：afplay "${join(SONGS_DIR, localName)}"` : ''}`);
    }
    return;
  }

  if (cmd === 'config') {
    const sub = rest[0];
    if (sub === 'show') {
      const c = { ...loadConfig() };
      if (c.apiKey) c.apiKey = String(c.apiKey).slice(0, 4) + '***' + String(c.apiKey).slice(-2);
      console.log(JSON.stringify(c, null, 2));
      return;
    }
    if (sub === 'set') {
      const [, key, ...valueParts] = rest;
      if (!key || valueParts.length === 0) { console.error('用法：config set <key> <value>（value 按 JSON 解析，失败则按字符串）'); process.exit(1); }
      const raw = valueParts.join(' ');
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      saveConfig({ [key]: value });
      console.log(`已写入 ${key}`);
      return;
    }
    console.error('config 子命令：show | set <key> <value>'); process.exit(1);
  }

  console.error(`未知命令：${cmd}`); process.exit(1);
};

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(2); });
