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

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }));
}
