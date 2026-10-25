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
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return;
    if (!isUserFacing(session)) return;
    const message = event?.data?.message;
    if (message?.role !== 'assistant') return;
    const text = textOf(message);
    if (text === '') return;
    const entry = {
      sessionId: session.id,
      seq: event.seq,
      time: event.time,
      text: text.slice(0, MAX_TEXT),
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

  /** Scan a session's committed events newest-first for its last reply. */
  const scanEvents = (events, form) => {
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== 'assistant/message') continue;
      const message = event?.data?.message;
      if (message?.role !== 'assistant') continue;
      const text = textOf(message);
      if (text === '') continue;
      return { sessionId: form, seq: event.seq, time: event.time, text: text.slice(0, MAX_TEXT) };
    }
    return null;
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
      diagnostics,
    });
  };

  // ── Singing: cloud music generation over a Suno-compatible API ──────────
  // API key and endpoint live in ~/.dsh/dsh-tts-reader/config.json (mode 600)
  // and never leave this machine; audio streams from the provider's CDN.

  const CONFIG_DIR = join(homedir(), '.dsh', 'dsh-tts-reader');
  const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
  const DEFAULT_BASE = 'https://api.sunoapi.org';

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
        baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : DEFAULT_BASE,
        model: typeof config.model === 'string' ? config.model : 'V6',
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
    const saved = await saveConfig(patch);
    sendJson(res, { ok: true, configured: typeof saved.apiKey === 'string' && saved.apiKey !== '' });
  };

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
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') await saveConfig({ apiKey: body.apiKey.trim() });
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : config.apiKey;
    if (typeof apiKey !== 'string' || apiKey === '') {
      sendJson(res, { ok: false, error: 'no-api-key' });
      return;
    }
    const lyrics = typeof body.lyrics === 'string' ? body.lyrics.slice(0, 5000) : '';
    const style = typeof body.style === 'string' ? body.style.slice(0, 1000) : '';
    const title = typeof body.title === 'string' ? body.title.slice(0, 80) : '';
    const vocalGender = body.vocalGender === 'm' || body.vocalGender === 'f' ? body.vocalGender : undefined;
    if (lyrics === '' && style === '') {
      sendJson(res, { ok: false, error: 'lyrics-or-style required' });
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
    const { status, payload: provider } = await providerCall({ ...config, apiKey }, '/api/v1/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const taskId = provider?.data?.taskId;
    if ((status !== 200 && status !== 201) || typeof taskId !== 'string') {
      sendJson(res, {
        ok: false,
        providerStatus: status,
        providerCode: typeof provider?.code === 'number' ? provider.code : null,
        providerMsg: typeof provider?.msg === 'string' ? provider.msg : typeof provider?.message === 'string' ? provider.message : null,
      });
      return;
    }
    sendJson(res, { ok: true, taskId });
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
    sendJson(res, {
      ok: true,
      status: providerStatus,
      tracks,
      error: typeof data.errorMessage === 'string' && data.errorMessage !== '' ? data.errorMessage : null,
    });
  };

  ctx.effect(() => {
    const offs = [
      ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-config', handler: configHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-start', handler: singStartHandler }),
      ctx.webServer.register({ kind: 'prefix', path: '/dsh-tts/sing-status', handler: singStatusHandler }),
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
