window.__ModuleLoader__.load({
  id: 'dsh-tts-reader',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-tts/latest';

    /** UI strings for the two locales the harness ships; keyed 'zh' | 'en'. */
    const DICT = {
      zh: {
        speak: '朗读最新回复',
        stop: '停止朗读',
        autoRead: '自动朗读',
        loading: '获取中…',
        empty: '暂无可朗读的内容',
        failed: '朗读失败，请重试',
        unsupported: '当前浏览器不支持语音合成',
        mismatch: '未找到当前会话的回复，改读最新一条',
        cloning: '西施嗓合成中',
        voice: '音色',
        sing: '唱歌',
        singLyrics: '歌词（留空则 AI 自动写词）',
        singStyle: '风格，如：慵懒民谣 女声 温暖',
        singTitle: '歌曲名称（可选）',
        singGender: '声线',
        genderAuto: '自动',
        genderM: '男声',
        genderF: '女声',
        apiKey: 'API Key',
        saveKey: '保存',
        keySaved: '密钥已保存 ✓',
        needKey: '请先在面板里填写并保存 API Key',
        generate: '✨ 生成歌曲',
        generating: '生成中（约 1~2 分钟）',
        songReady: '生成完成，开始播放 🎵',
        songFailed: '生成失败',
        stopSong: '⏹ 停止播放',
        modeCloud: '☁️ 云端（Suno）',
        modeLocal: '💻 本机（免费）',
        duration: '时长(秒)',
        localNote: '本机模式：歌词留空 = 纯音乐；生成比云端快',
        history: '🎞 历史歌曲（点按重听）',
        historyEmpty: '还没有生成过歌曲',
        durationHint: '歌词约 {n} 字，30 秒可能唱不完、会漏字；将自动延长到约 {m} 秒',
        engineBusy: '引擎正在生成上一首歌，请等它完成再点（本机一次只能生成一首）',
        download: '下载这首',
      },
      en: {
        speak: 'Read latest reply',
        stop: 'Stop reading',
        autoRead: 'Auto-read',
        loading: 'Loading…',
        empty: 'Nothing to read yet',
        failed: 'Reading failed, try again',
        unsupported: 'Speech synthesis is not supported in this browser',
        mismatch: 'No reply for this session yet, reading the newest one',
        cloning: 'Cloning voice',
        voice: 'Voice',
        sing: 'Sing',
        singLyrics: 'Lyrics (empty = AI writes them)',
        singStyle: 'Style, e.g. mellow folk female vocal warm',
        singTitle: 'Song title (optional)',
        singGender: 'Vocal',
        genderAuto: 'Auto',
        genderM: 'Male',
        genderF: 'Female',
        apiKey: 'API Key',
        saveKey: 'Save',
        keySaved: 'Key saved ✓',
        needKey: 'Set and save your API Key in the panel first',
        generate: '✨ Generate song',
        generating: 'Generating (about 1-2 min)',
        songReady: 'Done, playing 🎵',
        songFailed: 'Generation failed',
        stopSong: '⏹ Stop playback',
        modeCloud: '☁️ Cloud (Suno)',
        modeLocal: '💻 Local (free)',
        duration: 'Length (s)',
        localNote: 'Local mode: empty lyrics = instrumental; usually faster than cloud',
        history: '🎞 History (tap to replay)',
        historyEmpty: 'No songs generated yet',
        durationHint: 'About {n} lyric characters: a {m}s song is safer, otherwise words get dropped; duration auto-extends',
        engineBusy: 'The engine is still rendering the previous song; wait for it to finish (one song at a time)',
        download: 'Download this song',
      },
    };

    /** Resolve the active UI language through the Client locale service. */
    function currentLang(locale) {
      try {
        // LocaleSnapshot: { active, locales, revision }; ids are 'zh' | 'en'.
        const active = locale?.getLocale?.()?.active ?? locale?.getSnapshot?.()?.active
          ?? locale?.getLocale?.()?.id ?? locale?.getSnapshot?.()?.id;
        if (typeof active === 'string' && active !== '') return active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {}
      // Default to Chinese when the locale service cannot answer: the button
      // lives in a Chinese-first UI and the replies are usually Chinese.
      return 'zh';
    }

    /**
     * Resolve the conversation id from a uiSession store binding:
     * `binding.hooks.session` snapshot first, then the binding's own key or
     * props (same fallback chain the shipped boot-animation plugin uses).
     */
    function resolveSessionId(binding) {
      const session = binding?.hooks?.session;
      let snapshot = null;
      try {
        if (session !== undefined && typeof session.getSnapshot === 'function') snapshot = session.getSnapshot();
      } catch {}
      const candidate = (snapshot !== null && typeof snapshot === 'object' && 'sessionId' in snapshot ? snapshot.sessionId : undefined)
        ?? (typeof binding?.key === 'string' ? binding.key : undefined)
        ?? (typeof binding?.props?.sessionId === 'string' ? binding.props.sessionId : undefined);
      return typeof candidate === 'string' && candidate !== '' ? candidate : null;
    }

    /** Id-equality tolerant of the `session-` prefix and letter case. */
    function sameSession(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
      const norm = (s) => (s.startsWith('session-') ? s.slice(8) : s).toLowerCase();
      return norm(a) === norm(b);
    }

    /** Tiny stable string hash — identifies one reply without keeping it. */
    function hashText(text) {
      let h1 = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h1 ^= text.charCodeAt(i);
        h1 = Math.imul(h1, 0x01000193);
      }
      return String(h1 >>> 0) + ':' + String(text.length);
    }

    /**
     * Turn markdown-ish reply text into something speakable.
     *
     * NEVER spoken (stripped):
     * - code fences and their language tags — the block CONTENT is read;
     * - markdown images `![alt](url)`;
     * - URLs (replaced by the word "链接" / "link");
     * - link markup — the link TEXT is read, the target dropped;
     * - emojis, pictographs, dingbats, arrows, keycaps, flags (icons);
     * - decorative brackets and symbols: 《》〈〉「」【】（）() [] {} ~ ～ “” etc.;
     * - heading / list / quote / hashtag / table markers, horizontal rules.
     *
     * Kept as natural pauses (never spoken as words by the voice):
     * ，。！？；：、… and line breaks.
     */
    function stripForSpeech(raw) {
      return String(raw)
        // ``` fences with their language tag; the block CONTENT stays.
        .replace(/```[A-Za-z0-9+#._-]*[ \t]*\n?/g, '')
        .replace(/`([^`]*)`/g, '$1')
        // Images are never spoken; link text is.
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // Kaomoji in any bracket style: (￣o￣)（ฅ´>ω•ฅ）_(:з」∠)_ — short
        // symbol-only groups with no CJK text inside; stripped WHOLE so the
        // bracket removal below cannot leave "￣o￣" behind to be spoken.
        .replace(/[（(][^一-鿿（）()]{1,14}[）)]/g, (m) => (/[￣ω▽☆♪•´ฅ><・εз∀∧∠□]/u.test(m) ? ' ' : m))
        // Bare kaomoji runs and decorative bars: ￣ω￣、☆★～
        .replace(/[￣▽☆★♪・•]{2,}/g, ' ')
        // Sleep marks: zzZ / zzz
        .replace(/\bzz+z?\b/gi, ' ')
        // Emojis and pictographs, including ZWJ / variation-selector runs.
        .replace(/[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}\u{FE0F}\u{200D}\u{20E3}]+/gu, '')
        // Decorative brackets/symbols vanish; the words inside survive.
        .replace(/[《》〈〉「」『』【】〔〕（）()\[\]{}＜＞<>“”‘’"'\uFF5E~～·•\u00B6]+/g, '')
        // Heading, list, quote, hashtag and table markup.
        .replace(/^#{1,6}[ \t]+/gm, '')
        .replace(/#+[ \t]*/g, '')
        .replace(/^\s*[-*+]\s+/gm, '，')
        .replace(/^\s*>\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/https?:\/\/\S+/g, '链接')
        .replace(/\|/g, '，')
        .replace(/^={3,}\s*$|^-{3,}\s*$/gm, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
    }

    /**
     * One shared speech state for the whole page: every button renders from
     * it, and the apply-scope session guard clears it when the displayed
     * conversation changes mid-speech.
     *
     * `snapshot()` MUST return a stable reference between changes — React's
     * useSyncExternalStore treats a fresh object per call as an infinite
     * update loop and blanks the slot entry.
     */
    const speech = {
      speaking: false,
      sessionId: null,
      listeners: new Set(),
      cache: { speaking: false, sessionId: null },
      subscribe(fn) {
        speech.listeners.add(fn);
        return () => { speech.listeners.delete(fn); };
      },
      snapshot() {
        return speech.cache;
      },
      emit() {
        speech.cache = { speaking: speech.speaking, sessionId: speech.sessionId };
        for (const fn of [...speech.listeners]) fn();
      },
      start(sessionId) {
        speech.speaking = true;
        speech.sessionId = sessionId;
        speech.emit();
      },
      clear() {
        if (!speech.speaking && speech.sessionId === null) return;
        speech.speaking = false;
        speech.sessionId = null;
        speech.emit();
      },
    };

    let keepAlive = null;
    /**
     * Monotonic token for the newest utterance. `cancel()` races in Chromium:
     * a superseded utterance fires `onend` late (after `synth.cancel()`), and
     * without this guard that stale settle cleared the shared state while the
     * replacing utterance was still speaking — which made the auto-read guard
     * see "idle" and start a second, overlapping voice.
     */
    let utteranceToken = 0;
    function clearKeepAlive() {
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }

    /** One song at a time, module-wide (shared with the session guard). */
    let songAudio = null;
    let songPoll = null;
    /** Clone-voice playback: wav pre-rendered by the Host via the F5 skill. */
    let cloneAudio = null;
    /** True while waiting for the Host to finish synthesizing a clone wav. */
    let cloneBusy = false;
    /** Bumped to cancel an in-flight clone wait (stop / supersede). */
    let cloneToken = 0;
    /** Conversation the clone wait/playback belongs to; null = none. */
    let cloneSession = null;
    function stopCloneAudio() {
      cloneToken++;
      cloneBusy = false;
      cloneSession = null;
      if (cloneAudio !== null) {
        try { cloneAudio.pause(); } catch {}
        cloneAudio = null;
      }
    }
    /** Conversation that started the current song/poll; null = none. */
    let lastSongSession = null;
    function stopSong() {
      if (songPoll !== null) {
        clearInterval(songPoll);
        songPoll = null;
      }
      if (songAudio !== null) {
        try { songAudio.pause(); } catch {}
        songAudio = null;
      }
    }
    function startSong(url, onEnded) {
      stopSong();
      const audio = new Audio(url);
      songAudio = audio;
      if (typeof onEnded === 'function') audio.onended = onEnded;
      audio.play().catch(() => {});
    }

    /**
     * Hard-stop the engine. `cancel()` alone occasionally loses the race in
     * Chromium, so a follow-up check cancels (and pauses) again.
     */
    function stopEngine() {
      clearKeepAlive();
      stopCloneAudio(); // clone-voice playback rides the same stop button
      const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis;
      speech.clear();
      if (!synth) return;
      try { synth.cancel(); } catch {}
      setTimeout(() => {
        try { if (synth.speaking || synth.pending) { synth.cancel(); synth.pause(); } } catch {}
      }, 200);
    }
    /** localStorage key of the user's chosen voice (by voiceURI). */
    const VOICE_KEY = 'dsh-tts-reader.voice';
    /** localStorage key of the auto-read toggle. */
    const AUTO_KEY = 'dsh-tts-reader.autoRead';

    /** The persisted voiceURI, or '' when the user never picked one. */
    function savedVoiceUri() {
      try {
        return localStorage.getItem(VOICE_KEY) ?? '';
      } catch {
        return '';
      }
    }

    function saveVoiceUri(uri) {
      try {
        if (uri === '') localStorage.removeItem(VOICE_KEY);
        else localStorage.setItem(VOICE_KEY, uri);
      } catch {}
    }

    /**
     * Resolve the voice for one utterance: the user's saved choice wins;
     * otherwise pick the best available voice for the reply's language.
     */
    function chooseVoice(synth, text) {
      let voices = [];
      try {
        voices = synth.getVoices?.() ?? [];
      } catch {}
      if (!Array.isArray(voices) || voices.length === 0) return null;
      const saved = savedVoiceUri();
      if (saved !== '') {
        const match = voices.find((v) => String(v?.voiceURI ?? v?.name ?? '') === saved);
        if (match !== undefined) return match;
      }
      const zh = /[一-鿿]/.test(text);
      const match = voices.filter((v) => {
        const lang = String(v?.lang || '');
        return zh ? /^zh|chinese/i.test(lang) : /^(en|english)/i.test(lang);
      });
      if (match.length === 0) return null;
      const preferred = match.find((v) => /ting|mei|female|tingting|婷/i.test(String(v?.name || '')));
      return preferred ?? match[0] ?? null;
    }

    const STYLE_CLASS = 'dsh-tts-reader-btn';
    const SELECT_CLASS = 'dsh-tts-reader-voice';
    const HIST_CLASS = 'dsh-tts-reader-hist';
    const ROW_CLASS = 'dsh-tts-reader-hist-row';
    const DL_CLASS = 'dsh-tts-reader-dl';

    function IconSpeaker() {
      return h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' } },
        h('path', { d: 'M4 9h4l5-4v14l-5-4H4z', fill: 'currentColor' }),
        h('path', { d: 'M16 8.5c1.6 1 2.6 2.2 2.6 3.5S17.6 14.5 16 15.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }),
        h('path', { d: 'M18.4 5.8c2.6 1.7 4.1 3.8 4.1 6.2s-1.5 4.5-4.1 6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', opacity: '0.65' }));
    }

    function IconStop() {
      return h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' } },
        h('rect', { x: '6', y: '6', width: '12', height: '12', rx: '2', fill: 'currentColor' }));
    }

    function TtsButton({ translate, getSessionId }) {
      // Render from the shared store so a conversation switch (which may not
      // remount this entry) still flips every visible button back to idle.
      const state = React.useSyncExternalStore(speech.subscribe, speech.snapshot, speech.snapshot);
      const speaking = state.speaking;
      const [hint, setHint] = React.useState('');
      const [autoRead, setAutoRead] = React.useState(() => {
        try {
          return localStorage.getItem(AUTO_KEY) === '1';
        } catch {
          return false;
        }
      });
      const t = translate;

      React.useEffect(() => () => { stopEngine(); }, []);

      /**
       * Clone-voice channel (西施嗓): ask the Host for a pre-rendered wav of
       * THIS session's newest reply. The Host synthesizes on demand (slow:
       * ~15-50s/sentence) and this side polls until it is ready, then plays
       * the wav. Returns true when the clone voice took over; false means the
       * caller should fall back to browser speechSynthesis.
       */
      const speakClone = async (sid, token) => {
        try {
          let url = '/dsh-tts/clone-audio';
          if (typeof sid === 'string' && sid !== '') url += '?session=' + encodeURIComponent(sid);
          let waited = 0;
          for (;;) {
            if (token !== cloneToken) return false; // stopped / superseded
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json();
            if (data?.ok === true && data.ready === true && typeof data.url === 'string') {
              return await new Promise((resolve) => {
                if (token !== cloneToken) { resolve(false); return; }
                stopSong();
                try { window.speechSynthesis.cancel(); } catch {}
                const audio = new Audio(data.url);
                cloneAudio = audio;
                const settle = (ok) => {
                  if (cloneAudio === audio) cloneAudio = null;
                  if (token === cloneToken) { cloneSession = null; speech.clear(); }
                  resolve(ok);
                };
                audio.onended = () => settle(true);
                audio.onerror = () => settle(false);
                speech.start(typeof sid === 'string' && sid !== '' ? sid : null);
                setHint('');
                audio.play().catch(() => settle(false));
              });
            }
            if (data?.ok !== true) return false; // unavailable / too-long / failed
            // Still synthesizing: show progress, then re-poll (cap ~4 min).
            waited += 2;
            if (waited > 240) return false;
            setHint(`${t('cloning')}${waited}s`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch {
          return false;
        }
      };

      /**
       * Best voice first: the Host-rendered clone wav (西施嗓), browser
       * speechSynthesis as the universal fallback.
       */
      const speakBest = async (raw, sid, answered) => {
        stopCloneAudio(); // one voice at a time
        const token = ++cloneToken;
        cloneBusy = true;
        cloneSession = typeof sid === 'string' && sid !== '' ? sid : null;
        setHint(t('loading'));
        const cloneOk = await speakClone(sid, token);
        cloneBusy = false;
        if (cloneOk) return;
        if (token !== cloneToken) return; // user stopped mid-wait
        cloneSession = null;
        speakText(raw, sid, answered); // fallback voice
      };

      /** Speak one reply fetched from the Host; shared by click and auto-read. */
      const speakText = (raw, sid, answered) => {
        // When the Host had to fall back to another session's reply, say so
        // instead of silently reading the wrong conversation.
        if (sid !== null && answered !== null && !sameSession(sid, answered)) setHint(t('mismatch'));
        else setHint('');
        const clean = stripForSpeech(raw).slice(0, 4000);
        if (clean === '') {
          setHint((prev) => prev || t('empty'));
          return;
        }
        const synth = window.speechSynthesis;
        stopSong(); // one voice at a time: starting speech stops any song
        try { synth.cancel(); } catch {}
        // Speak paragraph by paragraph with a real breath in between: one
        // utterance for the whole reply gave the engine no reason to pause at
        // line breaks, so long replies ran on without any rest.
        const paragraphs = clean.split(/\n+/).map((s) => s.trim()).filter((s) => s !== '');
        const segments = paragraphs.length > 0 ? paragraphs : [clean];
        // Only the CURRENT sequence may settle the shared state; a cancelled
        // (superseded) utterance firing `onend` late must not clear the newer
        // state nor advance the old queue.
        const token = ++utteranceToken;
        speech.start(typeof sid === 'string' && sid !== '' ? sid : answered);
        clearKeepAlive();
        let index = 0;
        const speakNext = () => {
          if (token !== utteranceToken) return; // stopped / superseded
          if (index >= segments.length) {
            clearKeepAlive();
            speech.clear();
            return;
          }
          const text = segments[index++];
          const isLast = index >= segments.length;
          const utter = new SpeechSynthesisUtterance(text);
          const voice = chooseVoice(synth, text);
          if (voice !== null) utter.voice = voice;
          utter.lang = voice?.lang ?? (/^[一-鿿]/.test(text) ? 'zh-CN' : 'en-US');
          utter.rate = 1;
          const settle = () => {
            if (token !== utteranceToken) return; // stale: a newer voice took over
            if (isLast) {
              clearKeepAlive();
              speech.clear();
              return;
            }
            // Paragraph break = catch your breath before the next one.
            setTimeout(speakNext, 800);
          };
          utter.onend = settle;
          utter.onerror = settle;
          synth.speak(utter);
        };
        speakNext();
        // Chrome stops long utterances after ~15s unless nudged; pause/resume
        // while it is actually speaking keeps long replies alive.
        keepAlive = setInterval(() => {
          try {
            if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
          } catch {}
        }, 9000);
      };

      const start = async () => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
          setHint(t('unsupported'));
          return;
        }
        setHint(t('loading'));
        let raw = '';
        let answered = null;
        // Read the conversation the page is showing, so the button always
        // speaks THIS session's newest reply rather than another one.
        let sid = null;
        try {
          sid = getSessionId();
        } catch {}
        try {
          let url = ROUTE;
          if (typeof sid === 'string' && sid !== '') url += '?session=' + encodeURIComponent(sid);
          const res = await fetch(url, { cache: 'no-store' });
          const data = await res.json();
          raw = typeof data?.text === 'string' ? data.text : '';
          answered = typeof data?.session === 'string' ? data.session : null;
        } catch {
          setHint(t('failed'));
          return;
        }
        void speakBest(raw, sid, answered);
      };

      // Auto-read: watch the displayed conversation and speak each NEW
      // reply once. Polling (2s) — the Host route is cheap and local.
      // `lastSeen` holds the last spoken reply's identity so an unchanged
      // reply is never read twice; switching conversations re-anchors it.
      const lastSeenRef = React.useRef('');
      React.useEffect(() => {
        if (!autoRead) return undefined;
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
          setHint(t('unsupported'));
          setAutoRead(false);
          return undefined;
        }
        let stopped = false;
        let currentSid = null;
        const poll = async () => {
          if (stopped || speech.speaking || cloneBusy) return; // don't fetch mid-speech
          let sid = null;
          try {
            sid = getSessionId();
          } catch {}
          if (sid === null) return;
          if (!sameSession(sid, currentSid)) {
            // Conversation switched: re-anchor without speaking the past.
            currentSid = sid;
            try {
              let url = ROUTE + '?session=' + encodeURIComponent(sid);
              const res = await fetch(url, { cache: 'no-store' });
              const data = await res.json();
              const text = typeof data?.text === 'string' ? data.text : '';
              lastSeenRef.current = text === '' ? '' : hashText(text);
              return;
            } catch {
              return;
            }
          }
          try {
            const res = await fetch(ROUTE + '?session=' + encodeURIComponent(sid), { cache: 'no-store' });
            const data = await res.json();
            if (data?.session != null && !sameSession(String(data.session), sid)) return; // fallback reply: not ours
            const text = typeof data?.text === 'string' ? data.text : '';
            if (text === '') return;
            const key = hashText(text);
            if (key === lastSeenRef.current) return; // same reply, already read
            lastSeenRef.current = key;
            // The fetch above is async: the manual button (or an earlier poll)
            // may have STARTED speaking while it was in flight. Re-check here
            // or we'd cancel+restart and Chromium could play both at once.
            if (speech.speaking || cloneBusy) return;
            void speakBest(text, sid, String(data.session ?? ''));
          } catch {}
        };
        const timer = setInterval(() => void poll(), 2000);
        // Anchor immediately so the CURRENT reply is not replayed on enable.
        void poll();
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [autoRead]);

      const toggleAutoRead = () => {
        setAutoRead((v) => {
          const next = !v;
          try {
            if (next) localStorage.setItem(AUTO_KEY, '1');
            else localStorage.removeItem(AUTO_KEY);
          } catch {}
          return next;
        });
      };

      const onClick = () => {
        if (speech.speaking || cloneBusy) stopEngine(); // cloneBusy: cancel a pending synthesis wait
        else void start();
      };

      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('style', {}, `.${STYLE_CLASS}{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;`
          + `border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;`
          + `color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;cursor:pointer;}`
          + `.${STYLE_CLASS}:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}`
          + `.${STYLE_CLASS}[data-speaking="true"]{color:var(--dsw-alias-brand-primary);`
          + `border-color:var(--dsw-alias-brand-primary);}`
          + `.${SELECT_CLASS}{max-width:180px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1);`
          + `border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);`
          + `font-size:12px;line-height:16px;cursor:pointer;}`
          + `.${HIST_CLASS}{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;`
          + `padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;`
          + `color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;cursor:pointer;text-align:left;}`
          + `.${HIST_CLASS}:hover{background:var(--dsw-alias-bg-layer-2);}`
          + `.${ROW_CLASS}{display:flex;align-items:center;gap:4px;}`
          + `.${DL_CLASS}{display:inline-flex;align-items:center;justify-content:center;`
          + `flex:0 0 auto;width:26px;height:22px;border:1px solid var(--dsw-alias-border-l1);`
          + `border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);`
          + `font-size:12px;text-decoration:none;cursor:pointer;}`
          + `.${DL_CLASS}:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}`),
        h('button', {
          type: 'button',
          class: STYLE_CLASS,
          'data-speaking': speaking || cloneBusy ? 'true' : 'false',
          onClick,
          title: speaking || cloneBusy ? t('stop') : t('speak'),
        }, speaking || cloneBusy ? h(IconStop) : h(IconSpeaker), h('span', {}, speaking || cloneBusy ? t('stop') : t('speak'))),
        h('button', {
          type: 'button',
          class: STYLE_CLASS,
          'data-speaking': autoRead ? 'true' : 'false',
          onClick: toggleAutoRead,
          title: t('autoRead'),
        }, h('span', {}, autoRead ? '🔔' : '🔕'), h('span', {}, t('autoRead'))),
        // Voice picker hidden on request: the default voice is remembered in
        // savedVoiceUri(), and switching is done by asking the agent.
        null,
        h(SingPanel, { translate, getSessionId }),
        hint !== '' ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, hint) : null);
    }

    /**
     * Voice picker: every voice the browser exposes (Chinese first), the
     * user's choice persisted by voiceURI. Voices can arrive async, so the
     * list refreshes on `voiceschanged`.
     */
    function VoiceSelect({ translate }) {
      const t = translate;
      const [voices, setVoices] = React.useState(() => {
        try {
          return (window.speechSynthesis?.getVoices?.() ?? []).slice();
        } catch {
          return [];
        }
      });
      const [selected, setSelected] = React.useState(() => savedVoiceUri());

      React.useEffect(() => {
        const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis;
        if (!synth) return undefined;
        const refresh = () => {
          try {
            setVoices((synth.getVoices?.() ?? []).slice());
          } catch {}
        };
        refresh();
        synth.addEventListener?.('voiceschanged', refresh);
        // Some engines populate the list late without firing the event.
        const retry = setTimeout(refresh, 1500);
        return () => {
          synth.removeEventListener?.('voiceschanged', refresh);
          clearTimeout(retry);
        };
      }, []);

      if (voices.length === 0) return null;
      // Chinese voices first, then the rest; keep each entry's own label.
      const ordered = [
        ...voices.filter((v) => /^zh|chinese/i.test(String(v?.lang || ''))),
        ...voices.filter((v) => !/^zh|chinese/i.test(String(v?.lang || ''))),
      ];

      const onChange = (event) => {
        const uri = event.target.value;
        saveVoiceUri(uri);
        setSelected(uri);
      };

      return h('select', {
        class: SELECT_CLASS,
        value: selected,
        onChange,
        title: t('voice'),
        'aria-label': t('voice'),
      }, ordered.map((v) => h('option', {
        key: String(v?.voiceURI ?? v?.name ?? ''),
        value: String(v?.voiceURI ?? v?.name ?? ''),
      }, `${v?.name ?? ''} (${v?.lang ?? ''})`)));
    }

    /**
     * Singing panel: lyrics + style -> provider task -> poll -> play the
     * finished track. The API key is saved on the Host (~/.dsh config,
     * mode 600) and only ever travels over loopback.
     */
    function SingPanel({ translate, getSessionId }) {
      const t = translate;
      const [open, setOpen] = React.useState(false);
      const [lyrics, setLyrics] = React.useState('');
      const [style, setStyle] = React.useState('');
      const [title, setTitle] = React.useState('');
      const [gender, setGender] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [configured, setConfigured] = React.useState(null);
      const [provider, setProvider] = React.useState('cloud');
      const [duration, setDuration] = React.useState(60);
      const [busy, setBusy] = React.useState(false);
      const [playing, setPlaying] = React.useState(false);
      const [status, setStatus] = React.useState('');
      const [history, setHistory] = React.useState([]);

      const refreshHistory = () => {
        fetch('/dsh-tts/sing-history', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => setHistory(Array.isArray(d?.songs) ? d.songs : []))
          .catch(() => {});
      };

      React.useEffect(() => {
        if (!open) return undefined;
        fetch('/dsh-tts/sing-config', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => {
            setConfigured(d?.configured === true);
            if (d?.provider === 'local' || d?.provider === 'cloud') setProvider(d.provider);
            if (typeof d?.localDuration === 'number') setDuration(d.localDuration);
          })
          .catch(() => setConfigured(false));
        refreshHistory();
        return () => {};
      }, [open]);

      React.useEffect(() => () => { stopSong(); lastSongSession = null; setPlaying(false); }, []);

      const finish = (message) => {
        stopSong(); // clears the poll
        lastSongSession = null;
        setBusy(false);
        setPlaying(false);
        setStatus(message);
      };

      const generate = async () => {
        if (busy) return;
        stopEngine(); // one voice at a time: a song stops any speech
        setBusy(true);
        setPlaying(false);
        setStatus(t('generating'));
        let sessionId = null;
        try {
          sessionId = getSessionId();
        } catch {}
        try {
          const startRes = await fetch('/dsh-tts/sing-start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider,
              lyrics,
              style,
              title,
              localDuration: duration,
              ...(gender !== '' ? { vocalGender: gender } : {}),
              ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
            }),
          });
          const start = await startRes.json();
          if (start?.ok !== true) {
            finish(start?.error === 'no-api-key' ? t('needKey') : start?.error === 'busy' ? t('engineBusy') : (start?.providerMsg ?? t('songFailed')));
            return;
          }
          if (apiKey.trim() !== '') {
            setConfigured(true);
            setApiKey('');
          }
          lastSongSession = sessionId;
          const taskId = start.taskId;
          let seconds = 0;
          songPoll = setInterval(async () => {
            seconds += 4;
            try {
              const r = await fetch('/dsh-tts/sing-status?taskId=' + encodeURIComponent(taskId), { cache: 'no-store' });
              const d = await r.json();
              if (d?.ok !== true) {
                finish(d?.providerMsg ?? t('songFailed'));
                return;
              }
              const track = Array.isArray(d.tracks) ? d.tracks.find((x) => typeof x?.url === 'string' && x.url !== '') : undefined;
              if (track !== undefined) {
                stopSong();
                lastSongSession = sessionId;
                setBusy(false);
                setPlaying(true);
                setStatus(`${t('songReady')} ${track.title ?? ''}`.trim());
                startSong(track.url, () => setPlaying(false));
                refreshHistory();
                return;
              }
              if (typeof d?.status === 'string' && /(FAILED|ERROR)/.test(d.status)) {
                finish(d?.error ?? t('songFailed'));
                return;
              }
              if (seconds >= 600) {
                finish(t('songFailed'));
                return;
              }
              setStatus(`${t('generating')} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
            } catch {}
          }, 4000);
        } catch {
          finish(t('songFailed'));
        }
      };

      const replay = (song) => {
        if (typeof song?.url !== 'string' || song.url === '') return;
        stopEngine(); // one voice at a time
        let sid = null;
        try {
          sid = getSessionId();
        } catch {}
        lastSongSession = sid;
        setPlaying(true);
        setStatus(`▶ ${(song.style || song.title || '').slice(0, 60)}`);
        startSong(song.url, () => setPlaying(false));
      };

      // Mirror of the Host's duration estimate: warn before wasting a run.
      const lyricChars = lyrics.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '').length;
      const estimatedSeconds = lyricChars === 0 ? 0 : Math.min(300, Math.ceil(lyricChars * 2.4) + 10);
      const durationTooShort = provider === 'local' && estimatedSeconds > duration;

      /** A filesystem-friendly download name derived from the song entry. */
      const downloadName = (song) => {
        const raw = String(song?.title || song?.style || song?.id || 'song').slice(0, 24);
        const safe = raw.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'song';
        const ext = /\.mp3($|\?)/i.test(String(song?.url ?? '')) ? 'mp3' : 'wav';
        const seconds = typeof song?.duration === 'number' ? Math.round(song.duration) : '';
        return `${safe}-${seconds}s.${ext}`;
      };

      const onClickSong = () => {
        if (playing || busy) {
          finish('');
          return;
        }
        void generate();
      };

      const inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: '16px',
      };

      return h(React.Fragment, {},
        h('button', {
          type: 'button',
          class: STYLE_CLASS,
          'data-speaking': busy || playing ? 'true' : 'false',
          onClick: () => setOpen((v) => !v),
          title: t('sing'),
        }, h('span', {}, '🎤'), h('span', {}, t('sing'))),
        open ? h('div', {
          style: {
            flex: '1 0 100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'stretch',
            gap: '10px',
            padding: '8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-1)',
            maxWidth: '760px',
          },
        },
        // LEFT column: the form. Scrolls on its own so a long status or a
        // tall lyric box never pushes the history column off screen.
        h('div', {
          style: {
            flex: '1 1 55%',
            minWidth: '0',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            maxHeight: '320px',
            overflowY: 'auto',
          },
        },
        h('textarea', {
          style: { ...inputStyle, minHeight: '120px', resize: 'vertical' },
          placeholder: t('singLyrics'),
          value: lyrics,
          onChange: (e) => setLyrics(e.target.value),
        }),
        h('input', {
          style: inputStyle,
          placeholder: t('singStyle'),
          value: style,
          onChange: (e) => setStyle(e.target.value),
        }),
        h('input', {
          style: inputStyle,
          placeholder: t('singTitle'),
          value: title,
          maxLength: 80,
          onChange: (e) => setTitle(e.target.value),
        }),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h('select', {
            style: { ...inputStyle, width: 'auto' },
            value: provider,
            onChange: (e) => setProvider(e.target.value),
            'aria-label': 'provider',
          },
          h('option', { value: 'local' }, t('modeLocal')),
          h('option', { value: 'cloud' }, t('modeCloud'))),
          provider === 'local'
            ? h('label', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: '4px', alignItems: 'center' } },
              t('duration'),
              h('input', {
                style: { ...inputStyle, width: '56px' },
                type: 'number',
                min: 10,
                max: 600,
                value: String(duration),
                onChange: (e) => setDuration(Number(e.target.value) || 60),
              }))
            : h('select', {
              style: { ...inputStyle, width: 'auto' },
              value: gender,
              onChange: (e) => setGender(e.target.value),
              'aria-label': t('singGender'),
            },
            h('option', { value: '' }, t('genderAuto')),
            h('option', { value: 'm' }, t('genderM')),
            h('option', { value: 'f' }, t('genderF'))),
        ),
        provider === 'cloud'
          ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: { ...inputStyle, width: '160px' },
              type: 'password',
              placeholder: configured === true ? '••••••••' : t('apiKey'),
              value: apiKey,
              onChange: (e) => setApiKey(e.target.value),
            }))
          : h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('localNote')),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            class: STYLE_CLASS,
            onClick: () => void generate(),
            disabled: busy,
            style: { opacity: busy ? 0.6 : 1 },
          }, h('span', {}, t('generate'))),
          playing ? h('button', { type: 'button', class: STYLE_CLASS, onClick: onClickSong }, h('span', {}, t('stopSong'))) : null,
          configured === true && apiKey.trim() !== '' ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('keySaved')) : null,
        ),
        status !== '' ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, status) : null,
        durationTooShort
          ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)' } },
            t('durationHint').replace('{n}', String(lyricChars)).replace('{m}', String(estimatedSeconds)))
          : null,
        ),
        // RIGHT column: song history. The header stays pinned; only the list
        // scrolls, so "历史歌曲" never slides out of view.
        h('div', {
          style: {
            flex: '1 1 45%',
            minWidth: '0',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            maxHeight: '320px',
            overflow: 'hidden',
            paddingLeft: '10px',
            borderLeft: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h('div', {
          style: {
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)',
            flex: '0 0 auto',
            position: 'sticky',
            top: '0',
            background: 'var(--dsw-alias-bg-layer-1)',
            zIndex: '1',
            paddingTop: '2px',
            paddingBottom: '2px',
          },
        }, t('history')),
        h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: '0',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          },
        },
        history.length === 0
          ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('historyEmpty'))
          : history.map((song) => h('div', { key: String(song?.id ?? ''), class: ROW_CLASS },
            h('button', {
              type: 'button',
              class: HIST_CLASS,
              onClick: () => replay(song),
              title: String(song?.style ?? ''),
              style: { flex: '1 1 auto', minWidth: '0' },
            },
            h('span', { style: { flex: '0 0 auto' } }, '▶'),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              String(song?.title || song?.style || song?.id || '')),
            h('span', { style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } },
              `${typeof song?.duration === 'number' ? Math.round(song.duration) : '?'}s ${song?.source === 'cloud' ? '☁️' : '💻'}`)),
            h('a', {
              class: DL_CLASS,
              href: String(song?.url ?? ''),
              download: downloadName(song),
              target: song?.source === 'cloud' ? '_blank' : undefined,
              rel: 'noopener',
              title: t('download'),
            }, '⬇')))))
        ) : null);
    }

    return {
      inject: ['slots', 'uiSession'],
      apply(ctx) {
        const uiSession = typeof ctx.uiSession !== 'undefined'
          ? ctx.uiSession
          : (typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined);
        /** The current-conversation store, when this composition provides one. */
        const store = () => {
          const candidate = uiSession?.adapter?.current;
          return candidate !== undefined && typeof candidate.getSnapshot === 'function' && typeof candidate.subscribe === 'function'
            ? candidate
            : null;
        };
        /** Freshly resolve the displayed conversation's id at click time. */
        const getSessionId = () => {
          try {
            const active = store();
            if (active === null) return null;
            return resolveSessionId(active.getSnapshot());
          } catch {
            return null;
          }
        };

        // Speaking belongs to ONE conversation: whenever the displayed
        // conversation changes mid-speech, stop the engine.
        let releaseGuard = () => {};
        const active = store();
        if (active !== null) {
          releaseGuard = active.subscribe(() => {
            // cloneBusy counts too: a pending clone SYNTHESIS keeps no audio
            // playing, but it would start speaking in the NEW conversation if
            // left alone — switch must cancel the wait as well.
            if (!speech.speaking && !cloneBusy && cloneAudio === null && songAudio === null && songPoll === null) return;
            const sid = getSessionId();
            if (speech.speaking && speech.sessionId !== null && sid !== null && !sameSession(sid, speech.sessionId)) stopEngine();
            if ((cloneBusy || cloneAudio !== null) && cloneSession !== null && sid !== null && !sameSession(sid, cloneSession)) stopEngine();
            if ((songAudio !== null || songPoll !== null) && sid !== null && lastSongSession !== null && !sameSession(sid, lastSongSession)) stopSong();
          });
        }
        ctx.effect(() => { releaseGuard(); clearKeepAlive(); });

        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        let translate = (key) => DICT[currentLang(locale)][key] ?? key;
        let bump = () => {};
        const Component = () => {
          const [, setTick] = React.useState(0);
          bump = () => setTick((n) => n + 1);
          return h(TtsButton, { translate, getSessionId });
        };
        if (typeof ctx.on === 'function') {
          ctx.on('locale/change', () => {
            translate = (key) => DICT[currentLang(locale)][key] ?? key;
            bump();
          });
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'tts-reader',
          order: 50,
          label: () => 'TTS Reader',
        }, Component));
      },
    };
  },
});
