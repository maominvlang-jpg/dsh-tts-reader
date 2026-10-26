/**
 * TTS Reader — Host half.
 *
 * The browser cannot read the session log itself, so this half listens to the
 * post-commit `session/event` feed, keeps the newest committed assistant text
 * of every user-facing session, and serves it over one same-origin GET route.
 * The Client half names the conversation it is showing (`?session=<id>`) and
 * speaks that session's newest reply; an unknown or absent id falls back to
 * the newest reply across all user-facing sessions. The route is read-only
 * and returns no session content other than assistant reply text.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat, statSync, createReadStream, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';

export const inject = ['webServer'];

/** Same-origin route the Client half fetches; no trailing slash. */
const ROUTE = '/dsh-tts/latest';

/** How many recent replies to keep in memory (newest first). */
const HISTORY_LIMIT = 20;

/** Speech length cap; longer replies are truncated, not rejected. */
const MAX_TEXT = 4000;

/**
 * Concatenate the `text` blocks of one assistant message.
 * @param {unknown} message - `event.data.message`.
 * @returns {string} plain text, '' when the message carries none.
 */
function textOf(message) {
  const content = /** @type {{ content?: unknown } | undefined} */ (message)?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    const typed = /** @type {{ type?: unknown, text?: unknown } | undefined} */ (block);
    if (typed?.type === 'text' && typeof typed.text === 'string') out += typed.text + '\n';
  }
  return out.trim();
}

/** True for sessions the user actually chats in (not subagents/delegations). */
function isUserFacing(session) {
  const header = /** @type {{ origin?: unknown, delegationDepth?: unknown } | undefined} */ (session)?.header;
  if (header === undefined) return true;
  if (header.origin === 'subagent') return false;
  return (typeof header.delegationDepth === 'number' ? header.delegationDepth : 0) === 0;
}

/**
 * Accepted spellings of one SessionId: the client may send the stored
 * `session-<uuid>` form or the bare uuid; the map may hold either.
 */
function idForms(id) {
  const out = [id];
  if (id.startsWith('session-')) out.push(id.slice('session-'.length));
  else out.push('session-' + id);
  return out;
}

/**
 * @param {Record<string, unknown>} ctx - host context with `webServer`.
 */
export function apply(ctx) {
  /** newest-first entries: { sessionId, seq, time, text } */
  const recent = [];
  /** Per-session newest entry, keyed by SessionId. */
  const bySession = new Map();
  /** newest entry across every user-facing session (fallback). */
  let latest = null;
  /**
   * Turn accumulator: everything the assistant said SINCE the user's last
   * message, per session. A single reply can commit several assistant
   * messages (text block, tool edit, closing text…); reading only the newest
   * one would skip the rest of the answer. `user/message` starts a new turn.
   */
  const turnText = new Map();

  ctx.on('session/event', (session, event) => {
    if (!isUserFacing(session)) return;
    if (event?.type === 'user/message') {
      // New turn: what was said before belongs to the previous question.
      turnText.delete(session.id);
      return;
    }
    if (event?.type !== 'assistant/message') return;
    const message = event?.data?.message;
    if (message?.role !== 'assistant') return;
    const text = textOf(message);
    if (text === '') return;
    const prior = turnText.get(session.id);
    const merged = (prior === undefined ? text : prior + '\n\n' + text).slice(0, MAX_TEXT);
    turnText.set(session.id, merged);
    const entry = {
      sessionId: session.id,
      seq: event.seq,
      time: event.time,
      text: merged,
    };
    latest = entry;
    bySession.set(session.id, entry);
    recent.unshift(entry);
    while (recent.length > HISTORY_LIMIT) {
      const dropped = recent.pop();
      const held = bySession.get(dropped.sessionId);
      if (held === dropped) bySession.delete(dropped.sessionId);
    }
  });

  /**
   * Scan a session's committed events newest-first for its last REPLY —
   * every assistant message after the newest user message, oldest first
   * (same turn-accumulation rule as the live feed above).
   */
  const scanEvents = (events, form) => {
    if (!Array.isArray(events)) return null;
    let userIndex = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'user/message') { userIndex = i; break; }
    }
    const chunks = [];
    let lastMeta = null;
    for (let i = userIndex + 1; i < events.length; i++) {
      const event = events[i];
      if (event?.type !== 'assistant/message') continue;
      const message = event?.data?.message;
      if (message?.role !== 'assistant') continue;
      const text = textOf(message);
      if (text === '') continue;
      chunks.push(text);
      lastMeta = event;
    }
    if (chunks.length === 0) return null;
    return {
      sessionId: form,
      seq: lastMeta.seq,
      time: lastMeta.time,
      text: chunks.join('\n\n').slice(0, MAX_TEXT),
    };
  };

  /**
   * Optional-service accessor: on a Host context, touching a service that is
   * not declared in this plugin's `inject` can THROW, so every lookup of
   * `sessions` / `agents` / `sessionQuery` goes through this guard and the
   * plugin degrades gracefully instead of failing the request.
   */
  const optional = (name) => {
    try {
      if (typeof ctx.get === 'function') {
        const value = ctx.get(name);
        if (value !== undefined) return value;
      }
    } catch {}
    try {
      return ctx[name];
    } catch {
      return undefined;
    }
  };

  /**
   * Resolve one session's newest reply. Chain, cheapest first:
   * 1. the live per-session cache fed by `session/event`;
   * 2. the in-memory session (store, then Agent registry) — a session that
   *    is open in the UI is loaded there even without a running Agent;
   * 3. the durable query service (`sessionQuery.readSession`, live-preferred
   *    and disk-backed) — covers idle sessions that are not loaded at all.
   */
  const lookup = async (wanted) => {
    /** Why each resolution step missed; returned for diagnosis. */
    const diagnostics = [];
    for (const form of idForms(wanted)) {
      const hit = bySession.get(form);
      if (hit !== undefined) return { entry: hit, diagnostics };
    }
    for (const form of idForms(wanted)) {
      let session;
      try {
        session = optional('sessions')?.get?.(form);
      } catch {}
      if (session === undefined) {
        try {
          session = optional('agents')?.get?.(form)?.session;
        } catch {}
      }
      const live = scanEvents(session?.events, form);
      if (live !== null) {
        bySession.set(form, live);
        return { entry: live, diagnostics };
      }
      diagnostics.push(`live miss (${form}): sessions.get=${session !== undefined}`);
    }
    for (const form of idForms(wanted)) {
      const service = optional('sessionQuery');
      if (service === undefined || typeof service.readSession !== 'function') {
        diagnostics.push(`sessionQuery unavailable (typeof=${typeof service})`);
        continue;
      }
      try {
        const snapshot = await service.readSession(form);
        const events = Array.isArray(snapshot?.events) ? snapshot.events : null;
        if (events === null) {
          diagnostics.push(`readSession(${form}): no events array (keys=${Object.keys(snapshot ?? {}).join(',')})`);
          continue;
        }
        const canonical = typeof snapshot?.session?.id === 'string' ? snapshot.session.id : form;
        const found = scanEvents(events, canonical);
        if (found !== null) {
          bySession.set(form, found);
          return { entry: found, diagnostics };
        }
        diagnostics.push(`readSession(${form}): ${events.length} events, no assistant text`);
      } catch (error) {
        diagnostics.push(`readSession(${form}) threw: ${error?.message ?? String(error)}`);
      }
    }
    return { entry: null, diagnostics };
  };

  /** @param {{ writeHead: (status: number, headers: Record<string, string>) => void, end: (body?: unknown) => void }} res */
  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };

  const handler = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    /** The conversation the page is showing; absence falls back to global. */
    let wanted = null;
    try {
      wanted = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session');
    } catch {}
    const { entry, diagnostics } = wanted !== null && wanted !== '' ? await lookup(wanted) : { entry: null, diagnostics: [] };
    const answer = entry ?? latest;
    if (answer === null) {
      sendJson(res, { ok: true, text: '', requested: wanted, source: 'empty', diagnostics });
      return;
    }
    sendJson(res, {
      ok: true,
      text: answer.text,
      session: answer.sessionId,
      requested: wanted,
      seq: answer.seq,
      time: answer.time,
      source: entry !== null ? 'session' : 'global',
      // Version marker: absent on hosts older than v1.6.6 (single-message
      // cache, no turn accumulation) — lets the Client detect a stale Host.
      turn: 1,
      diagnostics,
    });
  };

  // ── Singing: music generation, cloud (Suno-compatible) or LOCAL ─────────
  // Local mode talks to mlx-serve's ACE-Step endpoint on this machine
  // (free, offline); cloud mode talks to any Suno-compatible reseller.
  // API key and endpoints live in ~/.dsh/dsh-tts-reader/config.json (mode
  // 600) and never leave this machine.

  const CONFIG_DIR = join(homedir(), '.dsh', 'dsh-tts-reader');
  const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
  const SONGS_DIR = join(CONFIG_DIR, 'songs');
  const HISTORY_FILE = join(CONFIG_DIR, 'history.json');
  /**
   * Shared voice-channel state: `tts.mjs speak` claims it (and heartbeats it)
   * while reciting, so the read-aloud button and auto-read can yield — two
   * voices at once is exactly what this file exists to prevent. Stale after
   * PLAYBACK_TTL_MS without a heartbeat (a killed `speak` self-expires).
   */
  const PLAYBACK_FILE = join(CONFIG_DIR, 'playback.json');
  /** What the CLI already recited (newest last); read-aloud never repeats it. */
  const RECITED_FILE = join(CONFIG_DIR, 'recited.jsonl');
  const PLAYBACK_TTL_MS = 4000;
  const RECITED_TTL_MS = 2 * 60 * 60 * 1000;
  const HISTORY_LIMIT = 50;
  const DEFAULT_BASE = 'https://api.sunoapi.org';
  const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:8080';
  const DEFAULT_LOCAL_MODEL = 'ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit';

  let configCache = null;
  const loadConfig = async () => {
    if (configCache !== null) return configCache;
    try {
      configCache = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    } catch {
      configCache = {};
    }
    return configCache;
  };
  const saveConfig = async (patch) => {
    const merged = { ...(await loadConfig()), ...patch };
    configCache = merged;
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
    return merged;
  };

  const readJsonBody = (req, limit = 1024 * 256) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body === '' ? {} : JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

  /** Call the provider; never throws — provider errors come back as data. */
  const providerCall = async (config, path, init) => {
    const base = String(config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    try {
      const res = await fetch(base + path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...(init?.headers ?? {}),
        },
      });
      let payload = null;
      try {
        payload = await res.json();
      } catch {}
      return { status: res.status, payload };
    } catch (error) {
      return { status: 0, payload: { msg: String(error?.message ?? error) } };
    }
  };

  const configHandler = async (req, res) => {
    if (req.method === 'GET') {
      const config = await loadConfig();
      sendJson(res, {
        ok: true,
        configured: typeof config.apiKey === 'string' && config.apiKey !== '',
        provider: config.provider === 'local' ? 'local' : 'cloud',
        baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : DEFAULT_BASE,
        model: typeof config.model === 'string' ? config.model : 'V6',
        localBase: typeof config.localBase === 'string' ? config.localBase : DEFAULT_LOCAL_BASE,
        localDuration: typeof config.localDuration === 'number' ? config.localDuration : 60,
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: 'GET or POST required' }, 405);
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 400);
      return;
    }
    const patch = {};
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    if (typeof body.baseUrl === 'string' && /^https?:\/\//.test(body.baseUrl)) patch.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
    if (typeof body.model === 'string' && /^(V6|V6_MINI|V6_WILD)$/.test(body.model)) patch.model = body.model;
    if (body.provider === 'local' || body.provider === 'cloud') patch.provider = body.provider;
    if (typeof body.localBase === 'string' && /^https?:\/\//.test(body.localBase)) patch.localBase = body.localBase.trim().replace(/\/+$/, '');
    if (typeof body.localDuration === 'number' && body.localDuration >= 10 && body.localDuration <= 600) patch.localDuration = Math.round(body.localDuration);
    const saved = await saveConfig(patch);
    sendJson(res, { ok: true, configured: typeof saved.apiKey === 'string' && saved.apiKey !== '' });
  };

  /** In-memory local-generation jobs: taskId -> { status, tracks, error }. */
  const localJobs = new Map();
  let localSeq = 0;
  /** The engine renders one song at a time; refuse overlap with a clear error. */
  let localBusy = false;

  /** Structural lyric tags ACE-Step understands natively. */
  const LYRIC_STRUCTURE = /\[(verse|chorus|intro|outro|bridge|pre_chorus|hook)\]/i;

  /**
   * Turn pasted prose-style lyrics (sentences joined by punctuation) into
   * line-per-phrase lyrics the model can align syllables to. Text that
   * already carries [verse]/[chorus] tags passes through untouched.
   * Dropping punctuation and breaking lines is what stops the model from
   * skipping characters when it races to fit a phrase.
   */
  const preprocessLyrics = (text) => {
    if (text === '') return '';
    if (LYRIC_STRUCTURE.test(text)) return text;
    const segments = String(text)
      .split(/[\n。！？!?；;，,、]+/u)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const lines = [];
    for (const segment of segments) {
      // Only one-or-two character fragments (e.g. an exclamation) join the
      // previous phrase; a 3+ character segment is a real phrase of its own.
      if (segment.length <= 2 && lines.length > 0) lines[lines.length - 1] += segment;
      else lines.push(segment);
    }
    return lines.join('\n');
  };

  /** Rough seconds a Chinese lyric needs: ~2.4s per character plus intro. */
  const estimateLyricSeconds = (text) => {
    const chars = String(text).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').length;
    if (chars === 0) return 0;
    return Math.min(300, Math.ceil(chars * 2.4) + 10);
  };

  /**
   * Only ever EXTEND the requested duration so every lyric character has
   * room to be sung; instrumental (empty lyrics) keeps the request as-is.
   */
  const fitDuration = (lyrics, requested) => {
    const estimate = estimateLyricSeconds(lyrics);
    if (estimate === 0) return requested;
    return Math.min(600, Math.max(requested, estimate));
  };

  /** Generated-song history (newest first), persisted as JSON, capped. */
  let historyCache = null;
  const loadHistory = async () => {
    if (historyCache !== null) return historyCache;
    try {
      historyCache = JSON.parse(await readFile(HISTORY_FILE, 'utf8'));
      if (!Array.isArray(historyCache)) historyCache = [];
    } catch {
      historyCache = [];
    }
    return historyCache;
  };
  const persistHistory = async (list) => {
    historyCache = list;
    try {
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
      await writeFile(HISTORY_FILE, JSON.stringify(list), { mode: 0o600 });
    } catch {}
  };
  const appendHistory = async (entry) => {
    const list = await loadHistory();
    list.unshift(entry);
    while (list.length > HISTORY_LIMIT) list.pop();
    await persistHistory(list);
  };

  /**
   * POST JSON to the local engine with NO response timeout. `fetch` aborts
   * after 300s of waiting for headers, which kills every long render (a
   * 4-minute song needs 8+ minutes on an M3); node:http waits it out.
   */
  const engineCall = (url, payload) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const isAudio = String(response.headers['content-type'] ?? '').startsWith('audio');
        resolve({ ok: status >= 200 && status < 300, status, buffer, isAudio });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(0);
    request.end(body);
  });

  /** Run one ACE-Step generation through mlx-serve; stores the wav on disk. */
  const runLocalJob = async (taskId, config, options) => {
    const job = localJobs.get(taskId);
    // Fit the song to its lyrics: prose lyrics become one line per phrase,
    // and a too-short duration is extended so no character gets dropped.
    const lyrics = preprocessLyrics(options.lyrics);
    const duration = fitDuration(lyrics, options.duration);
    job.duration = duration;
    try {
      const base = String(config.localBase || DEFAULT_LOCAL_BASE).replace(/\/+$/, '');
      const result = await engineCall(`${base}/v1/audio/music-generations`, {
        model: typeof config.localModel === 'string' && config.localModel !== '' ? config.localModel : DEFAULT_LOCAL_MODEL,
        prompt: options.style,
        lyrics,
        vocal_language: 'zh',
        duration_seconds: duration,
      });
      if (!result.ok) {
        job.status = 'GENERATE_AUDIO_FAILED';
        job.error = `mlx-serve HTTP ${result.status} ${result.buffer.toString('utf8').slice(0, 300)}`;
        return;
      }
      const bytes = result.buffer;
      if (bytes.length < 1024) {
        job.status = 'GENERATE_AUDIO_FAILED';
        job.error = 'mlx-serve returned empty audio';
        return;
      }
      await mkdir(SONGS_DIR, { recursive: true, mode: 0o700 });
      const fileName = `local-${taskId}.wav`;
      await writeFile(join(SONGS_DIR, fileName), bytes, { mode: 0o600 });
      job.status = 'SUCCESS';
      job.tracks = [{ id: taskId, title: options.title, duration, url: `/dsh-tts/local-song/${fileName}` }];
      await appendHistory({
        id: taskId,
        source: 'local',
        url: `/dsh-tts/local-song/${fileName}`,
        style: options.style,
        title: options.title,
        duration,
        createdAt: Date.now(),
      });
    } catch (error) {
      job.status = 'GENERATE_AUDIO_FAILED';
      const message = String(error?.message ?? error);
      job.error = /fetch failed|ECONNREFUSED|ECONNRESET/i.test(message)
        ? '本机引擎无响应：可能正在忙（稍等几秒重试），或未启动。启动命令：mlx-serve --serve --port 8080 --model-dir ~/.mlx-serve/models --skip-mem-preflight'
        : message;
    }
  };

  /** Metadata of in-flight cloud tasks so history can label them later. */
  const cloudMeta = new Map();
  /** Cloud taskIds whose first track already entered history. */
  const cloudRecorded = new Set();

  const singStartHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { ok: false, error: 'POST required' }, 405);
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 400);
      return;
    }
    const config = await loadConfig();
    const provider = body.provider === 'local' || body.provider === 'cloud' ? body.provider : (config.provider === 'local' ? 'local' : 'cloud');
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') await saveConfig({ apiKey: body.apiKey.trim() });
    if (body.provider === 'local' || body.provider === 'cloud' || typeof body.localDuration === 'number') {
      const patch = { provider };
      if (typeof body.localDuration === 'number' && body.localDuration >= 10 && body.localDuration <= 600) patch.localDuration = Math.round(body.localDuration);
      await saveConfig(patch);
    }
    const lyrics = typeof body.lyrics === 'string' ? body.lyrics.slice(0, 5000) : '';
    const style = typeof body.style === 'string' ? body.style.slice(0, 1000) : '';
    const title = typeof body.title === 'string' ? body.title.slice(0, 80) : '';
    const vocalGender = body.vocalGender === 'm' || body.vocalGender === 'f' ? body.vocalGender : undefined;
    if (lyrics === '' && style === '') {
      sendJson(res, { ok: false, error: 'lyrics-or-style required' });
      return;
    }

    if (provider === 'local') {
      if (localBusy) {
        sendJson(res, { ok: false, error: 'busy' });
        return;
      }
      const fresh = await loadConfig();
      const localBase = typeof body.localBase === 'string' && /^https?:\/\//.test(body.localBase) ? body.localBase.trim().replace(/\/+$/, '') : (typeof fresh.localBase === 'string' ? fresh.localBase : DEFAULT_LOCAL_BASE);
      if (typeof body.localBase === 'string' && /^https?:\/\//.test(body.localBase)) await saveConfig({ localBase });
      const duration = typeof body.localDuration === 'number' && body.localDuration >= 10 && body.localDuration <= 600 ? Math.round(body.localDuration) : (typeof fresh.localDuration === 'number' ? fresh.localDuration : 60);
      localSeq += 1;
      const taskId = `local-${Date.now()}-${localSeq}`;
      localJobs.set(taskId, { status: 'PENDING', tracks: [], error: null });
      localBusy = true;
      void runLocalJob(taskId, { ...fresh, localBase }, { lyrics, style, title, duration }).finally(() => {
        localBusy = false;
      });
      sendJson(res, { ok: true, taskId });
      return;
    }

    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : config.apiKey;    if (typeof apiKey !== 'string' || apiKey === '') {
      sendJson(res, { ok: false, error: 'no-api-key' });
      return;
    }
    const payload = {
      customMode: true,
      instrumental: false,
      model: typeof config.model === 'string' && /^(V6|V6_MINI|V6_WILD)$/.test(config.model) ? config.model : 'V6',
      lyrics,
      style,
      ...(title !== '' ? { title } : {}),
      ...(vocalGender !== undefined ? { vocalGender } : {}),
    };
    const { status, payload: providerPayload } = await providerCall({ ...config, apiKey }, '/api/v1/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const taskId = providerPayload?.data?.taskId;
    if ((status !== 200 && status !== 201) || typeof taskId !== 'string') {
      sendJson(res, {
        ok: false,
        providerStatus: status,
        providerCode: typeof providerPayload?.code === 'number' ? providerPayload.code : null,
        providerMsg: typeof providerPayload?.msg === 'string' ? providerPayload.msg : typeof providerPayload?.message === 'string' ? providerPayload.message : null,
      });
      return;
    }
    sendJson(res, { ok: true, taskId });
    cloudMeta.set(taskId, { style, title });
  };

  const singStatusHandler = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    let taskId = null;
    try {
      taskId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('taskId');
    } catch {}
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) {
      sendJson(res, { ok: false, error: 'bad taskId' }, 400);
      return;
    }
    // Local (mlx-serve) jobs answer from memory — no API key involved.
    if (taskId.startsWith('local-')) {
      const job = localJobs.get(taskId);
      if (job === undefined) {
        sendJson(res, { ok: false, error: 'unknown local job' }, 404);
        return;
      }
      sendJson(res, { ok: true, status: job.status, tracks: job.tracks, error: job.error });
      return;
    }
    const config = await loadConfig();
    if (typeof config.apiKey !== 'string' || config.apiKey === '') {
      sendJson(res, { ok: false, error: 'no-api-key' });
      return;
    }
    const { status, payload: provider } = await providerCall(config, `/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
      method: 'GET',
    });
    if (status !== 200) {
      sendJson(res, {
        ok: false,
        providerStatus: status,
        providerMsg: typeof provider?.msg === 'string' ? provider.msg : null,
      });
      return;
    }
    const data = provider?.data ?? {};
    const providerStatus = typeof data.status === 'string' ? data.status : 'UNKNOWN';
    const rawTracks = Array.isArray(data?.response?.sunoData) ? data.response.sunoData : [];
    const tracks = [];
    for (const [index, track] of rawTracks.entries()) {
      if (typeof track?.audio_url !== 'string' || track.audio_url === '') continue;
      tracks.push({
        id: typeof track.id === 'string' ? track.id : String(index),
        title: typeof track.title === 'string' ? track.title : '',
        duration: typeof track.duration === 'number' ? track.duration : null,
        url: track.audio_url,
      });
    }
    // Record the FIRST ready track of each cloud task into history once.
    if (tracks.length > 0 && !cloudRecorded.has(taskId)) {
      cloudRecorded.add(taskId);
      const meta = cloudMeta.get(taskId) ?? {};
      cloudMeta.delete(taskId);
      await appendHistory({
        id: tracks[0].id,
        source: 'cloud',
        url: tracks[0].url,
        style: typeof meta.style === 'string' ? meta.style : '',
        title: tracks[0].title,
        duration: tracks[0].duration,
        createdAt: Date.now(),
      });
    }
    sendJson(res, {
      ok: true,
      status: providerStatus,
      tracks,
      error: typeof data.errorMessage === 'string' && data.errorMessage !== '' ? data.errorMessage : null,
    });
  };

  /** Song history, newest first; local entries vanish when their file is gone. */
  const historyHandler = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    const list = await loadHistory();
    const kept = [];
    for (const entry of list) {
      if (entry?.source === 'local') {
        const name = typeof entry.url === 'string' ? entry.url.split('/').pop() : '';
        const exists = await new Promise((resolve) => {
          if (!/^local-[A-Za-z0-9._-]{1,120}\.wav$/.test(String(name))) {
            resolve(false);
            return;
          }
          stat(join(SONGS_DIR, String(name)), (error, info) => resolve(error === null && info.isFile()));
        });
        if (!exists) continue; // file deleted -> drop from history
      }
      kept.push(entry);
    }
    if (kept.length !== list.length) await persistHistory(kept);
    sendJson(res, { ok: true, songs: kept });
  };

  /** Serve one locally generated song (name is strictly validated). */
  const localSongHandler = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    let name = null;
    try {
      name = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/dsh-tts/local-song/'.length);
    } catch {}
    if (typeof name !== 'string' || !/^local-[A-Za-z0-9._-]{1,120}\.wav$/.test(name)) {
      sendJson(res, { ok: false, error: 'bad song name' }, 400);
      return;
    }
    const file = join(SONGS_DIR, name);
    stat(file, (error, info) => {
      if (error !== null || !info.isFile()) {
        sendJson(res, { ok: false, error: 'not found' }, 404);
        return;
      }
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(info.size),
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(res);
    });
  };

  // ── Clone voice (F5-TTS-MLX): on-demand wav renders for the read-aloud
  // button and auto-read. The skill script (~/.dsh/skills/dsh-tts-reader)
  // does the synthesis; this half only queues jobs and serves cache files.
  // Renders are slow (~15-50s/sentence), so requests poll this route until
  // the wav is ready; the Client falls back to browser speech when this
  // half answers unavailable/too-long/failed.

  const CLONE_DIR = join(CONFIG_DIR, 'clone-cache');
  const CLONE_SCRIPT = join(homedir(), '.dsh', 'skills', 'dsh-tts-reader', 'scripts', 'tts.mjs');
  const CLONE_MAX_CHARS = 400; // F5 句级合成太慢，超长回复回退浏览器语音
  const CLONE_KEEP = 20;
  /** hash -> 'pending' | 'ready' | 'failed' */
  const cloneJobs = new Map();
  let cloneBusy = false;
  const cloneQueue = [];

  const cloneKey = (text, voice, mood) =>
    createHash('sha1').update(`${voice}\n${mood}\n${text}`).digest('hex').slice(0, 16);

  /** Host 进程的 node 不一定在 PATH 里，按候选位置解析。 */
  const nodeBin = () => {
    const self = String(process.execPath ?? '');
    if (/node$/i.test(self)) return self;
    const candidates = [
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ];
    try {
      const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
      for (const v of readdirSync(nvmRoot).sort().reverse()) candidates.push(join(nvmRoot, v, 'bin', 'node'));
    } catch {}
    return candidates.find((p) => existsSync(p)) ?? 'node';
  };

  const pruneCloneCache = () => {
    try {
      const files = readdirSync(CLONE_DIR)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => ({ f, m: statSync(join(CLONE_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const extra of files.slice(CLONE_KEEP)) {
        try { unlinkSync(join(CLONE_DIR, extra.f)); } catch {}
      }
    } catch {}
  };

  const pumpCloneQueue = () => {
    if (cloneBusy) return;
    const job = cloneQueue.shift();
    if (job === undefined) return;
    cloneBusy = true;
    const { key, file, text, voice, mood } = job;
    mkdirSync(CLONE_DIR, { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    // 正文走 stdin，不走 argv —— 回复里若含 "--file" 之类的词元不会被误认成参数
    const child = spawn(nodeBin(), [CLONE_SCRIPT, 'render', '--out', tmp, '--voice', voice, '--mood', mood], { stdio: ['pipe', 'ignore', 'ignore'] });
    try { child.stdin.end(text); } catch {}
    child.on('exit', (code) => {
      try {
        if (code === 0 && existsSync(tmp)) {
          renameSync(tmp, file);
          cloneJobs.set(key, 'ready');
          pruneCloneCache();
        } else {
          try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
          cloneJobs.set(key, 'failed');
        }
      } catch {
        cloneJobs.set(key, 'failed');
      }
      cloneBusy = false;
      pumpCloneQueue();
    });
    child.on('error', () => {
      cloneJobs.set(key, 'failed');
      cloneBusy = false;
      pumpCloneQueue();
    });
  };

  const cloneAudioHandler = async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    if (!existsSync(CLONE_SCRIPT)) {
      sendJson(res, { ok: false, reason: 'unavailable' }); // skill 未安装 → 浏览器语音兜底
      return;
    }
    let wanted = null;
    let explicitText = null;
    try {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      wanted = params.get('session');
      // The Client may name the exact chunk to render (auto-read speaks only
      // the NEW tail of a grown turn); session lookup is the fallback.
      const raw = params.get('text');
      if (typeof raw === 'string' && raw.trim() !== '') explicitText = raw;
    } catch {}
    let answer;
    if (explicitText !== null) {
      answer = { sessionId: wanted ?? '', seq: 0, time: Date.now(), text: explicitText.slice(0, MAX_TEXT) };
    } else {
      const { entry } = wanted !== null && wanted !== '' ? await lookup(wanted) : { entry: null };
      answer = entry ?? latest;
    }
    if (answer === null || answer.text === '') {
      sendJson(res, { ok: false, reason: 'empty' });
      return;
    }
    if (answer.text.length > CLONE_MAX_CHARS) {
      sendJson(res, { ok: false, reason: 'too-long' });
      return;
    }
    const config = await loadConfig();
    const voice = typeof config.voiceClone === 'string' && config.voiceClone !== '' ? config.voiceClone : null;
    if (voice === null) {
      sendJson(res, { ok: false, reason: 'unavailable' });
      return;
    }
    // auto = 逐句判情绪（含害羞/温柔/难过…），别钉死在 calm 上
    const mood = typeof config.mood === 'string' && config.mood !== '' ? config.mood : 'auto';
    const key = cloneKey(answer.text, voice, mood);
    const file = join(CLONE_DIR, `${key}.wav`);
    if (existsSync(file)) {
      sendJson(res, { ok: true, ready: true, url: `/dsh-tts/clone-wav/${key}.wav` });
      return;
    }
    const state = cloneJobs.get(key);
    if (state === 'failed') {
      sendJson(res, { ok: false, reason: 'failed' });
      return;
    }
    if (state !== 'ready' && state !== 'pending') {
      cloneJobs.set(key, 'pending');
      cloneQueue.push({ key, file, text: answer.text, voice, mood });
      pumpCloneQueue();
    }
    sendJson(res, { ok: true, synthesizing: true });
  };

  /** Serve one pre-rendered clone wav (name is strictly validated). */
  const cloneWavHandler = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    let key = null;
    try {
      key = new URL(req.url ?? '/', 'http://localhost').pathname.slice('/dsh-tts/clone-wav/'.length);
    } catch {}
    if (typeof key !== 'string' || !/^[a-f0-9]{16}\.wav$/.test(key)) {
      sendJson(res, { ok: false, error: 'bad key' }, 400);
      return;
    }
    stat(join(CLONE_DIR, key), (error, info) => {
      if (error !== null || !info.isFile()) {
        sendJson(res, { ok: false, error: 'not found' }, 404);
        return;
      }
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(info.size),
        'cache-control': 'no-store',
      });
      createReadStream(join(CLONE_DIR, key)).pipe(res);
    });
  };

  /**
   * Voice-channel arbitration, read-only: reports whether a CLI recital
   * (`tts.mjs speak`) currently owns the speaker, plus the text recited
   * recently. The Client yields to an active recital and skips content the
   * recital already performed (no poem spoken twice, in two voices).
   */
  const playbackHandler = (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, { ok: false, error: 'GET required' }, 405);
      return;
    }
    let cli = null;
    try {
      const raw = JSON.parse(readFileSync(PLAYBACK_FILE, 'utf8'));
      const pid = Number(raw?.pid) || 0;
      const beatAt = Number(raw?.beatAt) || 0;
      // Liveness beats the heartbeat: `tts.mjs` plays via execFileSync, which
      // BLOCKS its event loop mid-sentence, so beats legitimately stop for a
      // while. A live owner process means the recital is still going.
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          alive = error?.code === 'EPERM'; // alive, just not ours to signal
        }
      }
      if (alive || Date.now() - beatAt < PLAYBACK_TTL_MS) {
        cli = {
          active: true,
          phase: typeof raw.phase === 'string' ? raw.phase : 'playing',
          pid,
          since: Number(raw.startedAt) || beatAt,
          text: typeof raw.text === 'string' ? raw.text : '',
        };
      }
    } catch {}
    const recited = [];
    try {
      for (const line of readFileSync(RECITED_FILE, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry?.text === 'string' && entry.text !== ''
            && Date.now() - (Number(entry.at) || 0) < RECITED_TTL_MS) recited.push(entry.text);
        } catch {}
      }
    } catch {}
    sendJson(res, { ok: true, cli, recited: recited.slice(-20) });
  };

  ctx.effect(() => {
    const offs = [
      ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/playback', handler: playbackHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-config', handler: configHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-start', handler: singStartHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-status', handler: singStatusHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-history', handler: historyHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/local-song', handler: localSongHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/clone-audio', handler: cloneAudioHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/clone-wav', handler: cloneWavHandler }),
    ];
    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {}
      }
    };
  });
}
