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
        loading: '获取中…',
        empty: '暂无可朗读的内容',
        failed: '朗读失败，请重试',
        unsupported: '当前浏览器不支持语音合成',
        mismatch: '未找到当前会话的回复，改读最新一条',
        voice: '音色',
        sing: '唱歌',
        singLyrics: '歌词（留空则 AI 自动写词）',
        singStyle: '风格，如：慵懒民谣 女声 温暖',
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
      },
      en: {
        speak: 'Read latest reply',
        stop: 'Stop reading',
        loading: 'Loading…',
        empty: 'Nothing to read yet',
        failed: 'Reading failed, try again',
        unsupported: 'Speech synthesis is not supported in this browser',
        mismatch: 'No reply for this session yet, reading the newest one',
        voice: 'Voice',
        sing: 'Sing',
        singLyrics: 'Lyrics (empty = AI writes them)',
        singStyle: 'Style, e.g. mellow folk female vocal warm',
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
    function clearKeepAlive() {
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    }

    /** One song at a time, module-wide (shared with the session guard). */
    let songAudio = null;
    let songPoll = null;
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
    function startSong(url) {
      stopSong();
      const audio = new Audio(url);
      songAudio = audio;
      audio.play().catch(() => {});
    }

    /**
     * Hard-stop the engine. `cancel()` alone occasionally loses the race in
     * Chromium, so a follow-up check cancels (and pauses) again.
     */
    function stopEngine() {
      clearKeepAlive();
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
      const t = translate;

      React.useEffect(() => () => { stopEngine(); }, []);

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
        const utter = new SpeechSynthesisUtterance(clean);
        const voice = chooseVoice(synth, clean);
        if (voice !== null) utter.voice = voice;
        utter.lang = voice?.lang ?? (/^[一-鿿]/.test(clean) ? 'zh-CN' : 'en-US');
        utter.rate = 1;
        utter.onend = () => { clearKeepAlive(); speech.clear(); };
        utter.onerror = () => { clearKeepAlive(); speech.clear(); };
        speech.start(typeof sid === 'string' && sid !== '' ? sid : answered);
        synth.speak(utter);
        // Chrome stops long utterances after ~15s unless nudged; pause/resume
        // while it is actually speaking keeps long replies alive.
        clearKeepAlive();
        keepAlive = setInterval(() => {
          try {
            if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
          } catch {}
        }, 9000);
      };

      const onClick = () => {
        if (speech.speaking) stopEngine();
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
          + `font-size:12px;line-height:16px;cursor:pointer;}`),
        h('button', {
          type: 'button',
          class: STYLE_CLASS,
          'data-speaking': speaking ? 'true' : 'false',
          onClick,
          title: speaking ? t('stop') : t('speak'),
        }, speaking ? h(IconStop) : h(IconSpeaker), h('span', {}, speaking ? t('stop') : t('speak'))),
        h(VoiceSelect, { translate }),
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
      const [gender, setGender] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [configured, setConfigured] = React.useState(null);
      const [provider, setProvider] = React.useState('cloud');
      const [duration, setDuration] = React.useState(60);
      const [busy, setBusy] = React.useState(false);
      const [playing, setPlaying] = React.useState(false);
      const [status, setStatus] = React.useState('');

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
              localDuration: duration,
              ...(gender !== '' ? { vocalGender: gender } : {}),
              ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
            }),
          });
          const start = await startRes.json();
          if (start?.ok !== true) {
            finish(start?.error === 'no-api-key' ? t('needKey') : (start?.providerMsg ?? t('songFailed')));
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
                startSong(track.url);
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
            flexDirection: 'column',
            gap: '6px',
            padding: '8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-1)',
            maxWidth: '420px',
          },
        },
        h('textarea', {
          style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
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
            if (!speech.speaking && songAudio === null && songPoll === null) return;
            const sid = getSessionId();
            if (speech.speaking && speech.sessionId !== null && sid !== null && !sameSession(sid, speech.sessionId)) stopEngine();
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
