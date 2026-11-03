/**
 * dsh-voice —— 浏览器侧半身（客户端插件）
 *
 * 干三件事：
 *   1. 抄近道：盯住聊天区里"已经说完"的那一段回复，交给引擎念出来（不用宿主转发消息，读的就是你屏幕上看到的字）。
 *   2. 出声：优先用浏览器自带的 Web Speech；不可用时退回宿主 SAPI 合成（/dsh-voice/api/tts）。
 *   3. 开关：右下角一颗悬浮按钮 + 设置 → 语音播报（音色、语速、音量、停顿阈值都在那儿）。
 *
 * 两个坑写在前面：
 *   - 浏览器音色列表是异步的：speechSynthesis.getVoices() 第一次常常是空数组，
 *     要监听 voiceschanged 再取，否则"明明有音色却说没有"。
 *   - 自动播放策略：没有用户手势时 audio.play() / speak() 可能被拒。
 *     用户在页面里打过字、点过按钮就放行了；真被拒就退回另一条引擎，并把原因写进状态文件。
 */
window.__ModuleLoader__.load({
  id: "dsh-voice-tts",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    const CLIENT_VERSION = "0.1.9";
    // 同一页面里可能加载多份 bundle（热重载/新旧 id 并存），记一下自己是第几份。
    const INSTANCE = (window.__dshVoiceInstances = (window.__dshVoiceInstances || 0) + 1);
    const API = "/dsh-voice/api";
    const CFG_KEY = "dsh-voice/config@1";


    // 桌面壳把页面挂在 dsh-app:// 上，跟宿主 http://127.0.0.1:<port> 不是一个 origin：
    // 壳可能把同源请求代理给宿主，也可能要你走 __DSH_TRANSPORT__.streamBaseUrl。
    // 这里不猜——按"先同源、再显式 origin"的顺序试，哪个通就记哪个。
    let preferredBase = null;

    function transportBase() {
      try {
        const transport = window.__DSH_TRANSPORT__;
        if (transport && typeof transport.streamBaseUrl === "string" && transport.streamBaseUrl) {
          return transport.streamBaseUrl.replace(/\/+$/, "");
        }
      } catch { /* 普通浏览器没有 transport */ }
      return "";
    }

    function baseCandidates() {
      const list = [];
      if (preferredBase !== null) list.push(preferredBase);
      list.push("");            // 同源：桌面壳通常把 /api 代理给宿主
      const base = transportBase();
      if (base) list.push(base); // 宿主的 http origin（跨源，可能被 CORS 挡）
      return Array.from(new Set(list));
    }

    /** 调宿主接口：挨个试候选 base，4xx 说明"这个 base 不对"就换下一个。 */
    async function apiFetch(path, init) {
      let lastError = null;
      for (const base of baseCandidates()) {
        const url = base ? base + path : path;
        try {
          const response = await window.fetch(url, init);
          if (response.status === 404 || response.status === 401 || response.status === 403) {
            lastError = new Error(`${url} → HTTP ${response.status}`);
            continue;
          }
          preferredBase = base;
          return response;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("连不上宿主");
    }

    // ── 配置 ───────────────────────────────────────────────────────────────
    const DEFAULTS = {
      enabled: true,
      engine: "auto",       // auto | browser | sapi
      voiceURI: "",         // 浏览器音色
      hostVoice: "",        // SAPI 音色
      rate: 1,
      pitch: 1,
      volume: 1,
      settleMs: 1200,
      maxChars: 220,
      maxTurnChars: 600,
      skipCode: true,
      selection: true,
      autoScroll: true,
      greeted: false,
      greetedOk: false,
    };

    function loadConfig() {
      try {
        const raw = window.localStorage.getItem(CFG_KEY);
        if (!raw) return { ...DEFAULTS };
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
        if (merged.engine === "host") merged.engine = "sapi"; // 老配置里的叫法
        if (merged.engine === "local" || merged.engine === "edge") merged.engine = "auto"; // 已下线
        return merged;
      } catch { return { ...DEFAULTS }; }
    }

    let cfg = loadConfig();
    const cfgListeners = new Set();

    function updateConfig(patch) {
      const wasEnabled = cfg.enabled;
      cfg = { ...cfg, ...patch };
      try { window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* 隐私模式下写不进去，无妨 */ }
      for (const fn of cfgListeners) { try { fn(cfg); } catch { /* 单个订阅者崩了不连坐 */ } }
      // 开关状态变化统一在这里收口：谁改的都要停/起。
      if (wasEnabled !== cfg.enabled) {
        try {
          if (cfg.enabled) { watch.initializing = true; watch.turns.clear(); startWatching(1500); }
          else { stopAll(); stopWatching(); }
        } catch { /* 还没初始化完 */ }
      }
    }

    function subscribeConfig(fn) {
      cfgListeners.add(fn);
      return () => { cfgListeners.delete(fn); };
    }

    // ── 文本 ───────────────────────────────────────────────────────────────
    const SKIP_ALWAYS = [
      "[data-step-process]", "[data-turn-process]", "[data-turn-tail]", "[data-turn-trigger]",
      "[data-chat-running]", "[data-slot-error]", "button", "svg", "style", "script", "noscript", "template",
    ];
    const SKIP_CODE = ["pre", "code", "kbd", "samp"];

    /** 把一个节点里的可见文字抠出来，跳过思考/工具过程/按钮/（可选）代码块。 */
    function collectText(root, skipCode, doc) {
      const document_ = doc || window.document;
      const skip = skipCode ? SKIP_ALWAYS.concat(SKIP_CODE) : SKIP_ALWAYS;
      let out = "";
      const walker = document_.createTreeWalker(root, 4 /* SHOW_TEXT */);
      let node = walker.nextNode();
      while (node) {
        const value = node.nodeValue;
        if (value && value.trim()) {
          let el = node.parentElement;
          let skipped = false;
          while (el) {
            for (const sel of skip) {
              let hit = false;
              try { hit = typeof el.matches === "function" && el.matches(sel); } catch { hit = false; }
              if (hit) { skipped = true; break; }
            }
            if (skipped || el === root) break;
            el = el.parentElement;
          }
          if (!skipped) out += value + " ";
        }
        node = walker.nextNode();
      }
      return out;
    }

    /**
     * 把一段消息按"块"抠出来：每个 <p>/<li>/<h*>/<blockquote>/<pre>（或整块 div）算一段。
     * 返回 [{ el, text, start, end }]，start/end 是在"拼接全文"里的字符区间——
     * 有了它，念到第几个字就能查到该给哪个 DOM 元素画下划线。
     */
    const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, div";

    function blocksOf(root, skipCode) {
      if (!root) return { text: "", blocks: [] };
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll(BLOCK_SELECTOR)); } catch { nodes = []; }
      // 没有任何块级元素（纯文本、或者结构没认出来）→ 整块当一段
      if (!nodes.length) {
        const text = cleanText(collectText(root, skipCode));
        return text ? { text, blocks: [{ el: root, start: 0, end: text.length }] } : { text: "", blocks: [] };
      }
      // 只保留最内层：嵌套的 p/li 不要重复算（比如 li 里的 p）
      nodes = nodes.filter((el) => !nodes.some((other) => other !== el && el.contains(other)));
      const blocks = [];
      const parts = [];
      let cursor = 0;
      for (const el of nodes) {
        const text = cleanText(collectText(el, skipCode));
        if (!text) continue;
        blocks.push({ el, start: cursor, end: cursor + text.length });
        parts.push(text);
        cursor += text.length + 1; // 块之间用 \n 连接
      }
      return { text: parts.join("\n"), blocks };
    }

    /** 去掉 markdown 噪声——念出来的应该是人话，不是语法。 */
    function cleanText(raw) {
      return String(raw || "")
        .replace(/\r/g, "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s{0,3}[-*+]\s+/gm, "")
        .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
        .replace(/\*\*([^*]*)\*\*/g, "$1")
        .replace(/[*_~]{1,3}/g, "")
        .replace(/^\s*\|.*\|\s*$/gm, " ")
        .replace(/[ \t\u00a0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }

    /** 一轮太长就掐掉：念完一场长报告既费时又吵，默认只念前 1200 字。 */
    function clipForSpeech(text) {
      const value = String(text || "");
      const limit = Math.max(100, Math.min(6000, Number(cfg.maxTurnChars) || 600));
      if (value.length <= limit) return value;
      return value.slice(0, limit) + "。剩下的写在上面了，我不全念。";
    }

    /** 切句：一段一段念，第一句尽快出声，长句也不会卡住整段。 */
    function splitSpeech(text, maxChars) {
      const limit = Math.max(40, Math.min(600, Number(maxChars) || 220));
      const parts = [];
      for (const para of String(text || "").split(/\n+/)) {
        const line = para.trim();
        if (!line) continue;
        const sentences = line.match(/[^。！？!?；;…\.]+[。！？!?；;…\.]*/g) || [line];
        let buffer = "";
        for (const sentence of sentences) {
          const piece = sentence.trim();
          if (!piece) continue;
          if (buffer && buffer.length + piece.length > limit) { parts.push(buffer.trim()); buffer = ""; }
          buffer += piece;
          while (buffer.length > limit) { parts.push(buffer.slice(0, limit).trim()); buffer = buffer.slice(limit); }
        }
        if (buffer.trim()) parts.push(buffer.trim());
      }
      return parts.filter(Boolean);
    }

    // ── 引擎 ───────────────────────────────────────────────────────────────
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function synth() {
      try { return window.speechSynthesis || null; } catch { return null; }
    }

    function browserVoices() {
      const api = synth();
      if (!api) return [];
      try { return Array.from(api.getVoices() || []); } catch { return []; }
    }

    function pickBrowserVoice(voices) {
      if (!voices.length) return null;
      const wanted = cfg.voiceURI;
      if (wanted) {
        const exact = voices.find((v) => v.voiceURI === wanted || v.name === wanted);
        if (exact) return exact;
      }
      const chinese = voices.filter((v) => /^zh/i.test(v.lang || "") || /Chinese|Huihui|Xiaoxiao|Yaoyao|Kangkang|Tingting/i.test(v.name || ""));
      return chinese[0] || voices.find((v) => /^en/i.test(v.lang || "")) || voices[0];
    }

    const audio = {
      queue: [], running: false, cancelCurrent: null, stopFlag: false, currentPlayer: null,
      paused: false,
      // 暂停位置：queue[0] 这一段已经念到第几个字（绝对下标）
      resumeFrom: 0,
    };
    // 当前这一段念到哪了：progress.base 是这段的起始下标，progress.char 是段内偏移
    const progress = { base: 0, char: 0 };
    const speechListeners = new Set();
    let speaking = false;
    const errors = [];

    function setSpeaking(next) {
      speaking = next;
      for (const fn of speechListeners) { try { fn(next); } catch { /* 视图崩了不影响出声 */ } }
      try { paintRowActions(); } catch { /* 还没插按钮 */ }
    }

    function subscribeSpeaking(fn) {
      speechListeners.add(fn);
      return () => { speechListeners.delete(fn); };
    }

    // 「暂停」和「停止」是两件事：暂停保留队列位置，再点接着念；停止清空一切。
    let paused = false;
    const pausedListeners = new Set();

    function setPaused(next) {
      paused = next;
      for (const fn of pausedListeners) { try { fn(next); } catch { /* 同上 */ } }
      try { paintRowActions(); } catch { /* 还没插按钮 */ }
    }

    function subscribePaused(fn) {
      pausedListeners.add(fn);
      return () => { pausedListeners.delete(fn); };
    }

    function noteError(where, error) {
      const message = `${where}: ${String((error && error.message) || error || "unknown")}`;
      errors.push(message);
      if (errors.length > 8) errors.shift();
      report({ lastError: message }, true);
    }

    function speakBrowser(text) {
      return new Promise((resolve, reject) => {
        const api = synth();
        if (!api) { reject(new Error("这个环境没有 speechSynthesis")); return; }
        const utterance = new window.SpeechSynthesisUtterance(text);
        const voice = pickBrowserVoice(browserVoices());
        if (voice) {
          utterance.voice = voice;
          if (voice.lang) utterance.lang = voice.lang;
        }
        utterance.rate = clamp(Number(cfg.rate) || 1, 0.5, 2);
        utterance.pitch = clamp(Number(cfg.pitch) || 1, 0.5, 2);
        utterance.volume = clamp(Number(cfg.volume) || 1, 0, 1);
        let settled = false;
        let guard = 0;
        const done = (error) => {
          if (settled) return;
          settled = true;
          if (guard) { try { window.clearTimeout(guard); } catch { /* 没有 clearTimeout 也无妨 */ } }
          if (error) reject(error); else resolve();
        };
        // 同宿主播放：onend 不来也不能让队列永远停在这儿。
        guard = window.setTimeout(() => done(null), Math.min(180000, 20000 + text.length * 150));
        // 记录念到第几个字：暂停后从这里接着念。
        utterance.onboundary = (event) => {
          if (event && typeof event.charIndex === "number" && event.charIndex >= 0) progress.char = event.charIndex;
        };
        utterance.onend = () => done(null);
        utterance.onerror = (event) => done(new Error((event && event.error) || "浏览器合成失败"));
        audio.cancelCurrent = () => {
          try { utterance.onend = null; utterance.onerror = null; api.cancel(); } catch { /* 取消失败就算了 */ }
          done(null);
        };
        try { api.speak(utterance); } catch (error) { done(error); }
      });
    }

    /** 把一段音频（WAV Blob）放出来。 */
    function playBlob(blob, text) {
      const url = window.URL.createObjectURL(blob);
      return new Promise((resolve, reject) => {
        const player = new window.Audio(url);
        player.volume = clamp(Number(cfg.volume) || 1, 0, 1);
        let settled = false;
        let guard = 0;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (guard) { try { window.clearTimeout(guard); } catch { /* 没有 clearTimeout 也无妨 */ } }
          try { window.URL.revokeObjectURL(url); } catch { /* 已回收 */ }
          if (audio.currentPlayer === player) audio.currentPlayer = null;
          if (error) reject(error); else resolve();
        };
        // 看门狗：onended 万一不来（设备被抢、解码卡住），别把整条队列永久卡死。
        guard = window.setTimeout(() => finish(null), Math.min(180000, 20000 + text.length * 150));
        audio.cancelCurrent = () => { try { player.pause(); } catch { /* 已停 */ } finish(null); };
        audio.currentPlayer = player;
        // 宿主音色是整段 WAV：按播放进度估算念到第几个字（字数≈时长比例）
        player.ontimeupdate = () => {
          try {
            const duration = player.duration;
            if (!duration || !text.length) return;
            const ratio = Math.max(0, Math.min(1, player.currentTime / duration));
            progress.char = Math.floor(ratio * text.length);
          } catch { /* 有些播放器读不到 duration */ }
        };
        player.onended = () => finish(null);
        player.onerror = () => finish(new Error("音频播放失败"));
        const played = player.play();
        if (played && typeof played.catch === "function") played.catch((error) => finish(error));
      });
    }

    async function speakHost(text) {
      const response = await apiFetch(API + "/tts", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          voice: cfg.hostVoice || "",
          rate: Math.round((clamp(Number(cfg.rate) || 1, 0.5, 2) - 1) * 10),
          volume: Math.round(clamp(Number(cfg.volume) || 1, 0, 1) * 100),
        }),
      });
      if (!response.ok) {
        let detail = "";
        try { detail = await response.text(); } catch { /* 读不到就只报状态码 */ }
        throw new Error(`宿主合成失败 ${response.status} ${detail.slice(0, 240)}`);
      }
      return playBlob(await response.blob(), text);
    }

    /** 一段文字切成多长再送去合成。 */
    function segmentSize() {
      return Math.max(40, Number(cfg.maxChars) || 220);
    }

    async function speakChunk(text) {
      const mode = cfg.engine;
      if (mode === "browser") return speakBrowser(text);
      if (mode === "sapi") return speakHost(text);
      // auto：浏览器有音色就先念（快、可控），失败退回本机 SAPI
      if (browserVoices().length) {
        try {
          trace("speak via browser");
          await speakBrowser(text);
          if (!cfg.greetedOk) updateConfig({ greetedOk: true });
          return;
        } catch (error) {
          noteError("browser", error);
          return speakHost(text);
        }
      }
      try {
        trace("speak via sapi");
        const result = await speakHost(text);
        if (!cfg.greetedOk) updateConfig({ greetedOk: true });
        return result;
      } catch (error) {
        noteError("sapi", error);
        return speakBrowser(text);
      }
    }
    async function pump() {
      if (audio.running) return;
      audio.running = true;
      setSpeaking(true);
      try {
        while (audio.queue.length && !audio.stopFlag && !audio.paused) {
          // 先看队首、不急着删：暂停时这一段要留在队首，恢复后从"念到的那个字"接着念。
          const item = audio.queue[0];
          const chunk = typeof item === "string" ? item : String(item.text || "");
          const from = Math.max(0, Math.min(chunk.length, Number(audio.resumeFrom) || 0));
          const text = from > 0 ? chunk.slice(from) : chunk;
          audio.resumeFrom = 0;
          progress.base = from;
          progress.char = 0;
          if (typeof item === "object" && item) highlightAt(item, from);
          try { await speakChunk(text); } catch (error) { noteError("speak", error); }
          if (audio.paused) break;
          audio.queue.shift();
        }
      } finally {
        audio.running = false;
        audio.stopFlag = false;
        audio.cancelCurrent = null;
        setSpeaking(false);
        if (!audio.queue.length) clearHighlight();
        // 暂停解除但循环已经退出（取消是异步的）→ 再踢一脚，别让队列卡住。
        if (!audio.paused && audio.queue.length) window.setTimeout(() => pump(), 50);
      }
    }

    /** 暂停：掐掉当前播放，记住念到第几个字，这一条留在队首。 */
    function pauseAll() {
      if (paused) return;
      if (!audio.running && !audio.queue.length) return;
      audio.resumeFrom = (progress.base || 0) + (progress.char || 0);
      audio.paused = true;
      setPaused(true);
      const cancel = audio.cancelCurrent;
      audio.cancelCurrent = null;
      try { cancel && cancel(); } catch { /* 取消失败不阻塞 */ }
      try { synth() && synth().cancel(); } catch { /* 同上 */ }
      setSpeaking(false);
    }

    /** 继续：从队首那一段接着念。 */
    function resumeAll() {
      if (!paused) return;
      audio.paused = false;
      setPaused(false);
      if (audio.running) { window.setTimeout(() => { if (!audio.paused) pump(); }, 60); return; }
      pump();
    }

    // ── 朗读高亮：念到哪个块，就给哪个块画下划线 ──────────────────────────
    let readingEl = null;
    let lastUserScrollAt = 0;

    // 用户自己在滚页面时，别跟他抢滚动条（3 秒内不自动滚）
    function noteUserScroll() { lastUserScrollAt = Date.now(); }
    window.addEventListener("wheel", noteUserScroll, { passive: true, capture: true });
    window.addEventListener("touchmove", noteUserScroll, { passive: true, capture: true });

    function clearHighlight() {
      // 全量扫一遍：万一 React 换掉了节点，之前那个已经不在树上，只按变量清会漏
      try {
        for (const node of window.document.querySelectorAll(".dshv-reading")) node.classList.remove("dshv-reading");
      } catch { /* 查询失败就不清 */ }
      readingEl = null;
    }

    /** 把正在念的那块带进视野——否则你听到的是屏幕外的内容。 */
    function keepInView(el) {
      if (!cfg.autoScroll) return;
      if (Date.now() - lastUserScrollAt < 3000) return;   // 用户刚手动滚过，别抢
      try {
        const rect = el.getBoundingClientRect();
        const height = window.innerHeight || 800;
        if (rect.top >= 80 && rect.bottom <= height - 80) return;   // 已经在视野里
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch { /* 有些环境没有 scrollIntoView */ }
    }

    function highlight(el) {
      if (!el || el === readingEl) return;
      // 兜底：容器元素（里面还有段落）绝不加高亮——否则整条消息的文字都会被划线
      try {
        if (el.querySelector && el.querySelector("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td")) return;
      } catch { /* 查不了就照加 */ }
      clearHighlight();
      try {
        el.classList.add("dshv-reading");
        readingEl = el;
        keepInView(el);
      } catch { readingEl = null; }
    }

    /** 按"这段文字在原文里的绝对下标"找出所属的块，并给它加下划线。 */
    function highlightAt(item, from) {
      const blocks = item && item.blocks;
      if (!blocks || !blocks.length) return;
      const abs = (Number(item.at) || 0) + (Number(from) || 0);
      let hit = blocks[0];
      for (const block of blocks) {
        if (abs >= block.start && abs < block.end) { hit = block; break; }
        if (abs >= block.end) hit = block;
      }
      highlight(hit.el);
    }

    function enqueue(text, blocks, base) {
      const full = cleanText(text);
      const chunks = splitSpeech(full, segmentSize());
      trace(`enqueue ${chunks.length} 段 / ${String(text || "").length} 字`);
      if (!chunks.length) return;
      // 每一段都记住"它在原文里的起始下标"，念到它时才知道该高亮哪一块
      const items = [];
      let cursor = 0;
      for (const chunk of chunks) {
        let at = full.indexOf(chunk, cursor);
        if (at < 0) at = full.indexOf(chunk);
        if (at < 0) at = cursor;
        cursor = at + chunk.length;
        items.push({ text: chunk, at: (Number(base) || 0) + at, blocks: blocks || null });
      }
      // 上一次"停止"留下的刹车必须在新的内容进来时松开，否则队列永远不动（静默失效）。
      audio.stopFlag = false;
      audio.queue.push(...items);
      pump();
    }

    /** 手动点「念这条 / 念这段」：先掐掉正在念的，再念这一条。 */
    function speakNow(text, blocks) {
      const value = String(text || "").trim();
      if (!value) return;
      stopAll();
      enqueue(value, blocks);
    }

    /** 拖音量滑块时，正在放的那段也跟着变（浏览器语音改不了音量，只能下一段生效）。 */
    function applyLiveVolume(value) {
      const player = audio.currentPlayer;
      if (!player) return;
      try { player.volume = clamp(value, 0, 1); } catch { /* 有些播放器只读 */ }
    }

    function stopAll() {
      audio.queue.length = 0;
      audio.stopFlag = true;
      audio.paused = false;
      audio.resumeFrom = 0;
      progress.base = 0;
      progress.char = 0;
      setPaused(false);
      const cancel = audio.cancelCurrent;
      audio.cancelCurrent = null;
      audio.currentPlayer = null;
      try { cancel && cancel(); } catch { /* 取消失败不阻塞 */ }
      try { synth() && synth().cancel(); } catch { /* 同上 */ }
      clearHighlight();
      setSpeaking(false);
    }

    // ── 摘取"刚说完的那段" ─────────────────────────────────────────────────
    const watch = { timer: null, turns: new Map(), maxTurn: -1, misses: 0, initializing: true, lastText: "", warmUntil: 0 };

    function isRunning() {
      try { return window.document.querySelector("[data-chat-running]") !== null; } catch { return false; }
    }

    /**
     * 只扫最近三轮：一轮里可能有上百个 assistant-step（每个工具调用一步），
     * 全量抠字既慢又没必要——要念的永远是"刚结束的那一轮"。
     * 返回 turn → 该轮最后一个有字的 step 的文本（最终答复通常就是它）。
     */
    function scanTurns() {
      const nodes = window.document.querySelectorAll('[data-chat-flow-kind="assistant-step"][data-chat-turn]');
      const byTurn = new Map();
      for (const node of nodes) {
        const turn = Number(node.getAttribute("data-chat-turn"));
        if (!Number.isFinite(turn)) continue;
        const list = byTurn.get(turn);
        if (list) list.push(node); else byTurn.set(turn, [node]);
      }
      if (!byTurn.size) return new Map();
      const turns = Array.from(byTurn.keys()).sort((a, b) => a - b).slice(-3);
      const groups = new Map();
      for (const turn of turns) {
        const steps = byTurn.get(turn);
        let last = null;
        for (let index = steps.length - 1; index >= 0; index--) {
          const parsed = blocksOf(steps[index], cfg.skipCode);
          if (parsed.text) { last = { text: parsed.text, el: steps[index], blocks: parsed.blocks }; break; }
        }
        if (last) groups.set(turn, last);
      }
      return groups;
    }

    function tick() {
      if (!cfg.enabled) return;
      const groups = scanTurns();
      if (!groups.size) {
        watch.misses++;
        if (watch.misses === 30) report({ domMiss: true });
        return;
      }
      watch.misses = 0;
      const turns = Array.from(groups.keys()).sort((a, b) => a - b);
      const now = Date.now();

      // 预热：页面刚打开那几秒，历史消息还在陆续渲染（markdown 高亮、分页），
      // 文案会一波一波变——这时候一律只当"已念过"，否则一进页面就把旧回复重复念好几遍。
      if (now < watch.warmUntil) return;

      if (watch.initializing) {
        // 打开开关那一刻屏幕上的旧内容不念——只念之后新出现的。
        for (const turn of turns) {
          const text = clipForSpeech(groups.get(turn).text);
          if (text) watch.turns.set(turn, { text, at: now, spoken: text.length });
        }
        watch.maxTurn = turns[turns.length - 1];
        watch.initializing = false;
        return;
      }

      // 换会话：轮次号回头了，清空记忆重新记
      if (turns[turns.length - 1] < watch.maxTurn) {
        watch.turns.clear();
        watch.initializing = true;
        return;
      }
      watch.maxTurn = Math.max(watch.maxTurn, turns[turns.length - 1]);

      const running = isRunning();
      for (const turn of turns) {
        const entry = groups.get(turn);
        const text = clipForSpeech(entry.text);
        if (!text) continue;
        const state = watch.turns.get(turn);
        if (!state) {
          // 第一次看到这一轮：此刻没在生成 = 它是"进来之前就有的旧内容"（换工作区/切会话）。
          // 只登记不念；只有正生成时冒出来的，才算新文章，等它说完再念。
          watch.turns.set(turn, { text, at: now, spoken: running ? 0 : text.length });
          continue;
        }
        if (text !== state.text) {
          // 追加（新内容长出来了）→ 保留已念进度；否则是整段被替换（换会话/重置）→ 当已念，不重读
          const extended = text.startsWith(state.text);
          state.text = text;
          state.at = now;
          if (!extended) state.spoken = text.length;
          watch.turns.set(turn, state);
          continue;
        }
        if (state.spoken >= text.length) continue;
        if (running) continue;
        if (now - state.at < Math.max(300, Number(cfg.settleMs) || 1200)) continue;
        const delta = text.slice(state.spoken).trim();
        state.spoken = text.length;
        watch.turns.set(turn, state);
        if (delta) { watch.lastText = delta; enqueue(delta, entry.blocks, state.spoken - delta.length); }
      }

      // 老的轮次记忆留一点就够，别无限长
      if (watch.turns.size > 40) {
        const keepFrom = turns[0] - 5;
        for (const key of Array.from(watch.turns.keys())) if (key < keepFrom) watch.turns.delete(key);
      }
    }

    function startWatching(warmMs) {
      if (watch.timer) return;
      watch.initializing = true;
      watch.turns.clear();
      watch.maxTurn = -1;
      watch.warmUntil = Date.now() + (Number.isFinite(warmMs) ? warmMs : 4000);
      watch.timer = window.setInterval(tick, 400);
      report({ watching: true });
    }

    function stopWatching() {
      if (watch.timer) { window.clearInterval(watch.timer); watch.timer = null; }
    }

    // ── 状态回传（给人排障用，不是给模型看的） ──────────────────────────────
    let lastReportAt = 0;
    const traceLines = [];

    /** 留一串面包屑：出事的时候至少知道走到哪一步了（状态文件里能看见）。 */
    function trace(line) {
      const stamp = new Date().toISOString().slice(11, 19);
      traceLines.push(`${stamp} ${line}`);
      if (traceLines.length > 40) traceLines.shift();
      report({ trace: traceLines.slice() }, true);
    }

    function browserDiag() {
      let voices = [];
      try { voices = browserVoices().map((v) => `${v.name} (${v.lang})`); } catch { voices = []; }
      // DOM 上真实存在的节点种类：选择器写错时，这里就是证据
      let domKinds = [];
      let turns = 0;
      try {
        const kinds = new Set();
        for (const el of window.document.querySelectorAll("[data-chat-flow-kind]")) {
          kinds.add(el.getAttribute("data-chat-flow-kind"));
          if (kinds.size >= 12) break;
        }
        domKinds = Array.from(kinds);
        turns = window.document.querySelectorAll("[data-chat-flow-kind=\"assistant-step\"][data-chat-turn]").length;
      } catch { /* 页面还没渲染 */ }
      return {
        version: CLIENT_VERSION,
        instance: INSTANCE,
        instances: window.__dshVoiceInstances || 0,
        enabled: cfg.enabled,
        engine: cfg.engine,
        hasSpeechSynthesis: !!synth(),
        voices,
        domKinds,
        assistantSteps: turns,
        rowButtons: rowActionNodes().length,
        rowInserts,
        navIconPatches: navPatches,
        selectionReading: cfg.selection,
        // 结构探针：消息操作栏挂在哪个 turn 下、那一轮在文档里散着几个 step
        domProbe: (() => {
          try {
            const tail = window.document.querySelector("[data-turn-tail]");
            if (!tail) return { tail: false };
            const steps = stepsForTurn(tail);
            const texts = steps.map((step) => cleanText(collectText(step, cfg.skipCode))).filter(Boolean);
            return {
              tail: true,
              tailTurn: tail.getAttribute("data-turn-tail"),
              steps: steps.length,
              tailClock: !!tail.querySelector('[data-clock="end"]'),
              clockNodes: window.document.querySelectorAll("[data-clock]").length,
              tailButtons: Array.from(tail.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") || b.title || "?").slice(0, 12),
              totalLen: texts.join("\n").length,
              stepLens: texts.map((text) => text.length).slice(-6),
            };
          } catch (error) { return { error: String((error && error.message) || error) }; }
        })(),
        theme: (() => { try { return detectTheme(); } catch { return "unknown"; } })(),
        popoverCss: popoverCssProbe,
        errors: errors.slice(-8),
        href: String(window.location && window.location.href || ""),
        checkedAt: new Date().toISOString(),
      };
    }

    function report(patch, force) {
      const now = Date.now();
      if (!force && now - lastReportAt < 4000) return;
      lastReportAt = now;
      try {
        apiFetch(API + "/status", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ browser: { ...browserDiag(), ...(patch || {}) } }),
        }).catch(() => { /* 宿主没启路由也无所谓 */ });
      } catch { /* 同上 */ }
    }

    /** 探一次"我到底能不能跟宿主说话"：桌面壳与浏览器的差别全在这儿。 */
    async function probe() {
      const probes = [];
      const base = transportBase();
      for (const candidate of ["", base]) {
        if (candidate === "" && probes.some((p) => p.base === "")) continue;
        const url = (candidate ? candidate : "") + API + "/status";
        const started = Date.now();
        try {
          const response = await window.fetch(url, { credentials: "include", headers: { accept: "application/json" } });
          probes.push({ base: candidate || "same-origin", url, status: response.status, ms: Date.now() - started });
        } catch (error) {
          probes.push({ base: candidate || "same-origin", url, error: String((error && error.message) || error), ms: Date.now() - started });
        }
      }
      let transport = null;
      try {
        const t = window.__DSH_TRANSPORT__;
        if (t && typeof t === "object") transport = { keys: Object.keys(t), streamBaseUrl: typeof t.streamBaseUrl === "string" ? t.streamBaseUrl : null };
      } catch { /* 没有 */ }
      trace(`probe ${JSON.stringify(probes)}`);
      report({ probe: { href: String(window.location && window.location.href || ""), base, transport, probes, preferred: preferredBase } }, true);
    }

    // ── 消息操作栏里的「念这条」按钮（放在分支键后面） ─────────────────────
    const ROW_BTN_CLASS = "dshv-act";
    const ICON_SPEAK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
    const ICON_STOP = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

    let rowSweep = null;
    let heartBeat = null;
    let popover = null;
    let popoverHideTimer = 0;
    let lastRowCount = -1;
    let lastRowWithRow = -1;
    // 只记自己插进去的按钮：页面里可能同时存在多份 bundle，
    // 卸载时按 class 全删会把别人的也删掉，于是按钮反复"出现—消失"。
    const ownButtons = new Set();
    let rowInserts = 0;

    /**
     * 手动点喇叭时念的是「按钮上方那条消息的全文」。
     *
     * 坑：操作栏所在的 `[data-chat-turn]` 容器里**不含正文节点**（实测 stepsInRoot=0），
     * 正文是按 `data-chat-turn=<同一个号>` 散在文档里的兄弟节点。所以不能靠 closest + 子树查询，
     * 得先拿到这一轮的编号，再按编号去全文档捞。
     */
    function turnNumberFor(element) {
      try {
        const tail = element && element.closest ? element.closest("[data-turn-tail]") : null;
        if (tail) {
          const value = Number(tail.getAttribute("data-turn-tail"));
          if (Number.isFinite(value)) return value;
        }
        const host = element && element.closest ? element.closest("[data-chat-turn]") : null;
        if (host) {
          const value = Number(host.getAttribute("data-chat-turn"));
          if (Number.isFinite(value)) return value;
        }
      } catch { /* 结构不认识就走兜底 */ }
      return null;
    }

    function stepsForTurn(element) {
      const turn = turnNumberFor(element);
      if (Number.isFinite(turn)) {
        return Array.from(window.document.querySelectorAll(`[data-chat-flow-kind="assistant-step"][data-chat-turn="${turn}"]`));
      }
      // 没有轮次号：退而求其次，取按钮之前出现的所有 step
      const all = Array.from(window.document.querySelectorAll('[data-chat-flow-kind="assistant-step"]'));
      try {
        const before = all.filter((step) => (step.compareDocumentPosition(element) & 4) !== 0);
        if (before.length) return before;
      } catch { /* compareDocumentPosition 不可用 */ }
      return all;
    }

    /** 按钮正上方那条回复：最后一个有字的 step，带块结构（用于画下划线）。 */
    function turnBlocksFrom(element) {
      const steps = stepsForTurn(element);
      for (let index = steps.length - 1; index >= 0; index--) {
        const parsed = blocksOf(steps[index], cfg.skipCode);
        if (parsed.text) return parsed;
      }
      return { text: "", blocks: [] };
    }

    function turnTextFrom(element) {
      return turnBlocksFrom(element).text;
    }

    function createRowAction() {
      const button = window.document.createElement("button");
      button.type = "button";
      button.className = ROW_BTN_CLASS;
      button.title = "念全文";
      button.setAttribute("aria-label", "念全文");
      button.innerHTML = ICON_SPEAK;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (speaking) { stopAll(); return; }
        let where = "none";
        try {
          where = `turn=${turnNumberFor(button)}/steps=${stepsForTurn(button).length}`;
        } catch { where = "err"; }
        const parsed = turnBlocksFrom(button);
        trace(`click ${where} len=${parsed.text.length} blocks=${parsed.blocks.length} head=${JSON.stringify(parsed.text.slice(0, 24))}`);
        if (parsed.text) speakNow(parsed.text, parsed.blocks);
      });
      button.addEventListener("mouseenter", () => openPopover(button));
      button.addEventListener("mouseleave", scheduleClosePopover);
      return button;
    }

    /** 自愈式插入：React 重渲染把按钮挤掉也没关系，下一轮扫回来。 */
    function sweepRowActions() {
      const tails = window.document.querySelectorAll("[data-turn-tail]");
      let withRow = 0;
      let skipped = 0;
      let sweepError = "";
      for (const tail of tails) {
        try {
          const row = tail.querySelector('[data-clock="end"]');
          if (!row) continue;
          withRow += 1;
          if (row.querySelector("." + ROW_BTN_CLASS)) { skipped += 1; continue; }
          const button = createRowAction();
          rowInserts += 1;
          ownButtons.add(button);
          const last = row.lastElementChild;
          // 分支键后面 = 用量/时间那个 span 之前
          if (last && last.tagName === "SPAN") row.insertBefore(button, last);
          else row.appendChild(button);
        } catch (error) {
          sweepError = String((error && error.message) || error);
        }
      }
      // 按钮数量变了就报一次（远端排障用：0 说明选择器没命中）
      const count = rowActionNodes().length;
      if (count !== lastRowCount || withRow !== lastRowWithRow) {
        lastRowCount = count;
        lastRowWithRow = withRow;
        report({ rowButtons: count, rowTails: tails.length, rowWithRow: withRow, rowSkipped: skipped, rowInserts, rowError: sweepError }, true);
      }
    }

    function rowActionNodes() {
      return window.document.querySelectorAll("." + ROW_BTN_CLASS);
    }

    function paintRowActions() {
      for (const button of rowActionNodes()) {
        button.innerHTML = speaking ? ICON_STOP : ICON_SPEAK;
        button.title = speaking ? "停止播报" : "念全文";
        button.setAttribute("data-speaking", speaking ? "1" : "0");
      }
    }

    // ── 悬停弹出的小面板：自动播报 / 音量 / 语速 ────────────────────────────
    function scheduleClosePopover() {
      if (popoverHideTimer) window.clearTimeout(popoverHideTimer);
      popoverHideTimer = window.setTimeout(() => { closePopover(); }, 220);
    }

    function closePopover() {
      if (popoverHideTimer) { window.clearTimeout(popoverHideTimer); popoverHideTimer = 0; }
      if (!popover) return;
      popover.style.display = "none";
    }

    function buildPopover() {
      const el = window.document.createElement("div");
      el.className = "dshv-pop";
      el.addEventListener("mouseenter", () => { if (popoverHideTimer) { window.clearTimeout(popoverHideTimer); popoverHideTimer = 0; } });
      el.addEventListener("mouseleave", scheduleClosePopover);
      return el;
    }

    function renderPopover() {
      if (!popover) return;
      popover.textContent = "";
      const title = window.document.createElement("div");
      title.className = "dshv-pop-title";
      title.textContent = "语音播报";
      popover.appendChild(title);

      const switchRow = window.document.createElement("label");
      switchRow.className = "dshv-pop-row";
      const switchText = window.document.createElement("span");
      switchText.textContent = "自动播报新回复";
      const toggle = window.document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = !!cfg.enabled;
      toggle.addEventListener("change", () => {
        updateConfig({ enabled: toggle.checked });
      });
      switchRow.appendChild(switchText);
      switchRow.appendChild(toggle);
      popover.appendChild(switchRow);

      const slider = (label, min, max, step, value, format, onInput) => {
        const row = window.document.createElement("label");
        row.className = "dshv-pop-row";
        const name = window.document.createElement("span");
        const output = window.document.createElement("span");
        output.className = "dshv-pop-value";
        name.textContent = label;
        output.textContent = format(value);
        const input = window.document.createElement("input");
        input.type = "range";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        input.className = "dshv-pop-range";
        input.addEventListener("input", () => {
          const next = Number(input.value);
          output.textContent = format(next);
          onInput(next);
        });
        row.appendChild(name);
        row.appendChild(input);
        row.appendChild(output);
        popover.appendChild(row);
        return input;
      };

      slider("音量", 0, 100, 5, Math.round((Number(cfg.volume) || 1) * 100), (v) => `${Math.round(v)}%`, (value) => {
        updateConfig({ volume: value / 100 });
        applyLiveVolume(value / 100);
      });
      slider("语速", 0.5, 2, 0.1, Number(cfg.rate) || 1, (v) => `${Number(v).toFixed(1)}×`, (value) => {
        updateConfig({ rate: value });
      });

      const actions = window.document.createElement("div");
      actions.className = "dshv-pop-actions";
      const test = window.document.createElement("button");
      test.type = "button";
      test.textContent = "试听";
      test.addEventListener("click", () => speakNow("你好，这是语音播报的试听。"));
      const pause = window.document.createElement("button");
      pause.type = "button";
      pause.textContent = paused ? "继续" : "暂停";
      pause.addEventListener("click", () => {
        if (paused) resumeAll(); else pauseAll();
        pause.textContent = paused ? "继续" : "暂停";
      });
      actions.appendChild(test);
      actions.appendChild(pause);
      popover.appendChild(actions);
    }

    /**
     * 判断当前是深色还是浅色主题。
     * 不能死用 CSS 变量兜底：`--dsw-alias-bg-elevated` 在 DSH 里并不存在，
     * 兜底成深色底 + 主题的深色字 = 黑底黑字（浅色主题下就是截图里那样）。
     * 所以这里直接量一下页面的实际背景色，算亮度。
     */
    function parseColor(value) {
      if (!value) return null;
      const text = String(value).trim();
      const rgba = text.match(/^rgba?\(([^)]+)\)$/i);
      if (rgba) {
        const parts = rgba[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
          return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
        }
        return null;
      }
      const hex = text.match(/^#([0-9a-f]{3,8})$/i);
      if (hex) {
        const raw = hex[1];
        const expand = raw.length === 3 || raw.length === 4 ? raw.split("").map((c) => c + c).join("") : raw;
        const r = parseInt(expand.slice(0, 2), 16);
        const g = parseInt(expand.slice(2, 4), 16);
        const b = parseInt(expand.slice(4, 6), 16);
        const a = expand.length >= 8 ? parseInt(expand.slice(6, 8), 16) / 255 : 1;
        if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b, a };
      }
      return null;
    }

    function detectTheme() {
      const probe = (element) => {
        if (!element || typeof window.getComputedStyle !== "function") return null;
        try {
          const color = parseColor(window.getComputedStyle(element).backgroundColor);
          return color && color.a > 0.2 ? color : null;
        } catch { return null; }
      };
      const candidates = [
        window.document.body,
        window.document.documentElement,
        window.document.querySelector && window.document.querySelector("[data-chat-flow]"),
      ];
      for (const element of candidates) {
        const color = probe(element);
        if (!color) continue;
        const luminance = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
        return luminance < 128 ? "dark" : "light";
      }
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      } catch { /* 没有 matchMedia */ }
      return "light";
    }

    function openPopover(anchor) {
      if (!window.document.body) return;
      if (!popover) { popover = buildPopover(); window.document.body.appendChild(popover); }
      if (popoverHideTimer) { window.clearTimeout(popoverHideTimer); popoverHideTimer = 0; }
      popover.dataset.theme = detectTheme();
      renderPopover();
      popover.style.display = "block";
      popover.style.visibility = "hidden";
      const rect = anchor.getBoundingClientRect();
      const width = popover.offsetWidth || 216;
      const height = popover.offsetHeight || 150;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
      let top = rect.top - height - 8;
      if (top < 8) top = rect.bottom + 8;
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
      popover.style.visibility = "visible";
    }

    // ── 设置页导航图标：官方按 section id 写死映射，插件拿不到自定义图标位，
    //    所以等它渲染出来后，把「语音播报」那一行的齿轮换成"人头在说话"。 ──
    const NAV_ICON = [
      '<circle cx="9" cy="8" r="4"/>',
      '<path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/>',
      '<path d="M15.5 6.5a5 5 0 0 1 0 7"/>',
      '<path d="M18.5 4.5a9 9 0 0 1 0 11"/>',
    ].join("");

    let navSweep = null;
    let navPatches = 0;

    function patchNavIcon() {
      let buttons = [];
      try { buttons = Array.from(window.document.querySelectorAll("button")); } catch { return; }
      for (const button of buttons) {
        if (String(button.textContent || "").trim() !== "语音播报") continue;
        const svg = button.querySelector("svg");
        if (!svg || svg.getAttribute("data-dshv-nav") === "talk") continue;
        try {
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "1.8");
          svg.setAttribute("stroke-linecap", "round");
          svg.setAttribute("stroke-linejoin", "round");
          svg.innerHTML = NAV_ICON;
          svg.setAttribute("data-dshv-nav", "talk");
          navPatches += 1;
        } catch { /* React 可能正在替换这个节点 */ }
      }
    }

    // ── 选字阅读：选中一段就冒一个「念这段」 ────────────────────────────────
    function installSelectionReader() {
      if (!window.document.body) return () => {};
      const chip = window.document.createElement("button");
      chip.type = "button";
      chip.className = "dshv-chip";
      chip.textContent = "🔊 念这段";
      chip.style.display = "none";
      window.document.body.appendChild(chip);

      const hide = () => { chip.style.display = "none"; chip.dataset.text = ""; };

      chip.addEventListener("mousedown", (event) => event.preventDefault());
      chip.addEventListener("click", () => {
        const text = chip.dataset.text;
        hide();
        if (text) speakNow(text);
      });

      let timer = 0;
      const onSelection = () => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = 0;
          if (!cfg.selection) { hide(); return; }
          let selection = null;
          try { selection = window.getSelection(); } catch { selection = null; }
          const anchor = selection && selection.anchorNode;
          const anchorEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);

          // 输入框（textarea / input）的选区不在 window.getSelection 里，得从元素自己身上取
          let field = null;
          try { field = anchorEl && anchorEl.closest ? anchorEl.closest("textarea, input") : null; } catch { field = null; }

          if (field && !(field.closest && field.closest('[role="dialog"]'))) {
            const start = Number(field.selectionStart);
            const end = Number(field.selectionEnd);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { hide(); return; }
            const value = String(field.value || "").slice(start, end).trim();
            if (value.length < 2 || value.length > 3000) { hide(); return; }
            const box = field.getBoundingClientRect();
            chip.dataset.text = value;
            chip.style.display = "inline-flex";
            chip.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - 130, box.left + box.width / 2 - 52)))}px`;
            chip.style.top = `${Math.round(Math.max(8, box.top - 38))}px`;
            return;
          }

          if (!selection || selection.isCollapsed || selection.rangeCount === 0) { hide(); return; }
          const text = String(selection.toString() || "").trim();
          if (text.length < 2 || text.length > 3000) { hide(); return; }
          // 聊天区 或 输入框（contenteditable 编辑器）都算
          const inChat = anchorEl && anchorEl.closest && anchorEl.closest("[data-chat-flow], [data-chat-turn], [data-chat-flow-kind]");
          const inEditor = anchorEl && anchorEl.closest && anchorEl.closest('[contenteditable="true"], [contenteditable=""]');
          if (!inChat && !inEditor) { hide(); return; }
          let rect = null;
          try { rect = selection.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
          if (!rect || (!rect.width && !rect.height)) {
            // 编辑器里选区的 rect 偶尔是 0，退回到元素本身的框
            try { rect = inEditor ? anchorEl.getBoundingClientRect() : null; } catch { rect = null; }
          }
          if (!rect || (!rect.width && !rect.height)) { hide(); return; }
          chip.dataset.text = text;
          chip.style.display = "inline-flex";
          chip.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - 130, rect.left + rect.width / 2 - 52)))}px`;
          chip.style.top = `${Math.round(Math.max(8, rect.top - 38))}px`;
        }, 60);
      };

      const onDown = (event) => { if (event.target !== chip) hide(); };
      const onKey = (event) => { if (event.key === "Escape") hide(); };

      window.document.addEventListener("mouseup", onSelection, true);
      window.document.addEventListener("keyup", onSelection, true);
      window.document.addEventListener("mousedown", onDown, true);
      window.document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", hide, true);

      return () => {
        try { window.document.removeEventListener("mouseup", onSelection, true); } catch { /* 已卸载 */ }
        try { window.document.removeEventListener("keyup", onSelection, true); } catch { /* 已卸载 */ }
        try { window.document.removeEventListener("mousedown", onDown, true); } catch { /* 已卸载 */ }
        try { window.document.removeEventListener("keydown", onKey, true); } catch { /* 已卸载 */ }
        try { window.removeEventListener("scroll", hide, true); } catch { /* 已卸载 */ }
        try { chip.remove(); } catch { /* 已卸载 */ }
        if (timer) window.clearTimeout(timer);
      };
    }

    // ── 设置页 ─────────────────────────────────────────────────────────────
    const CSS = [
      ".dshv{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".dshv-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".dshv-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".dshv-rows{display:flex;flex-direction:column}",
      ".dshv-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".dshv-row:last-child{border-bottom:none}",
      ".dshv-row>div:first-child{flex:1;min-width:190px}",
      ".dshv-label{font-size:13px;line-height:19px}",
      ".dshv-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px;white-space:pre-line}",
      ".dshv-input,.dshv-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:190px;max-width:320px;outline:none}",
      ".dshv-input:focus-visible,.dshv-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".dshv-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".dshv-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".dshv-btn:disabled{opacity:.5;cursor:default}",
      ".dshv-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".dshv-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:220px;overflow:auto;margin-top:10px}",
      ".dshv-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".dshv-badge.ok{background:rgba(46,160,67,.16);color:#2ea043}",
      ".dshv-badge.bad{background:rgba(220,60,60,.16);color:#e5534b}",
      ".dshv-range{width:190px}",
      // 消息操作栏里的小喇叭
      ".dshv-act{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;border-radius:4px;transition:opacity .12s ease,background .12s ease}",
      ".dshv-act:hover{opacity:1;background:rgba(127,127,127,.14)}",
      ".dshv-act[data-speaking='1']{opacity:1;color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      // 悬停小面板：底色按主题明暗切换（别用不存在的 token 兜成黑底黑字）
      ".dshv-pop{position:fixed;z-index:2147483000;width:220px;box-sizing:border-box;padding:10px 12px;border-radius:10px;font-family:inherit;font-size:12px;display:none}",
      ".dshv-pop[data-theme='light']{background:#ffffff;color:#1b1b1f;border:.5px solid rgba(0,0,0,.14);box-shadow:0 10px 30px rgba(0,0,0,.18)}",
      ".dshv-pop[data-theme='dark']{background:#232428;color:#eceff4;border:.5px solid rgba(255,255,255,.16);box-shadow:0 10px 30px rgba(0,0,0,.45)}",
      ".dshv-pop-title{font-size:12px;font-weight:600;margin-bottom:8px;opacity:.85}",
      ".dshv-pop-row{display:flex;align-items:center;gap:8px;margin:6px 0;justify-content:space-between}",
      ".dshv-pop-row>span:first-child{white-space:nowrap}",
      ".dshv-pop-range{flex:1;min-width:0;accent-color:#4d6bfe}",
      ".dshv-pop-value{width:38px;text-align:right;opacity:.62}",
      ".dshv-pop-actions{display:flex;gap:8px;margin-top:10px}",
      ".dshv-pop-actions button{flex:1;height:26px;border-radius:6px;border:.5px solid currentColor;background:transparent;color:inherit;font-size:12px;cursor:pointer;opacity:.85}",
      ".dshv-pop-actions button:hover{background:rgba(127,127,127,.16);opacity:1}",
      // 选字阅读的小药丸
      ".dshv-chip{position:fixed;z-index:2147483001;display:none;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:999px;border:.5px solid rgba(127,127,127,.35);background:rgba(24,24,26,.92);color:#fff;font-size:12px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)}",
      ".dshv-chip:hover{background:rgba(40,40,44,.96)}",
      // 正在朗读的段落：一条下划线 + 淡底，扫一眼就知道念到哪
      ".dshv-reading{text-decoration:underline;text-decoration-thickness:3px;text-underline-offset:5px;text-decoration-color:#4d6bfe;background:rgba(77,107,254,.08);border-radius:4px;transition:background .15s ease}",
    ].join("");

    function injectCss() {
      const id = "dsh-voice/section.css";
      // 用"原地覆盖"而不是"有了就跳过"：插件热重载时旧 <style> 可能还挂在页面上，
      // 跳过就会留下上一版的配色（比如那个黑底黑字的小面板）。
      let tag = window.document.querySelector(`style[data-plugin-css="${id}"]`);
      if (!tag) {
        tag = window.document.createElement("style");
        tag.dataset.plugin = "dsh-voice";
        tag.dataset.pluginCss = id;
        window.document.head.appendChild(tag);
      }
      tag.textContent = CSS;
    }

    /** 量一下小面板实际算出来的颜色：远端就能确认"到底是白底还是黑底"。 */
    let popoverCssProbe = null;

    function probePopoverCss() {
      try {
        const probe = window.document.createElement("div");
        probe.className = "dshv-pop";
        probe.setAttribute("data-theme", "light");
        probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;visibility:hidden";
        window.document.body.appendChild(probe);
        const computed = window.getComputedStyle(probe);
        const result = { background: computed.backgroundColor, color: computed.color };
        probe.remove();
        popoverCssProbe = result;
        return result;
      } catch { return null; }
    }

    function Row({ label, hint, children }) {
      return h("div", { className: "dshv-row" },
        h("div", null,
          h("div", { className: "dshv-label" }, label),
          hint ? h("div", { className: "dshv-hint" }, hint) : null),
        children);
    }

    function Switch({ checked, onChange }) {
      return h("input", {
        type: "checkbox",
        checked: !!checked,
        onChange: (event) => onChange(event.target.checked),
        style: { width: "16px", height: "16px", marginTop: "2px", cursor: "pointer" },
      });
    }

    function VoiceSection() {
      const [state, setState] = useState(cfg);
      const [host, setHost] = useState({ loading: true, ok: false, voices: [], error: "", default: "" });
      const [voices, setVoices] = useState(() => browserVoices());
      const [isSpeaking, setIsSpeaking] = useState(speaking);
      const [isPaused, setIsPaused] = useState(paused);
      const [notice, setNotice] = useState("");
      const mounted = useRef(true);

      useEffect(() => {
        injectCss();
        mounted.current = true;
        const offCfg = subscribeConfig((next) => setState({ ...next }));
        const offSpeak = subscribeSpeaking(setIsSpeaking);
        const offPause = subscribePaused(setIsPaused);
        const api = synth();
        const onVoices = () => setVoices(browserVoices());
        if (api && typeof api.addEventListener === "function") api.addEventListener("voiceschanged", onVoices);
        onVoices();
        return () => {
          mounted.current = false;
          offCfg();
          offSpeak();
          offPause();
          if (api && typeof api.removeEventListener === "function") api.removeEventListener("voiceschanged", onVoices);
        };
      }, []);

      const loadHostVoices = useCallback(async () => {
        setHost((prev) => ({ ...prev, loading: true }));
        try {
          const response = await apiFetch(API + "/voices", { credentials: "include", headers: { accept: "application/json" } });
          const payload = await response.json();
          if (!mounted.current) return;
          setHost({
            loading: false,
            ok: !!payload.ok,
            voices: Array.isArray(payload.voices) ? payload.voices : [],
            error: payload.error || "",
            default: payload.default || "",
          });
        } catch (error) {
          if (!mounted.current) return;
          setHost({ loading: false, ok: false, voices: [], error: String((error && error.message) || error), default: "" });
        }
      }, []);

      useEffect(() => { loadHostVoices(); }, [loadHostVoices]);

      const set = (patch) => { updateConfig(patch); setState({ ...cfg }); };

      const sample = "你好，我是 DeepSeek Harness。语音播报已经接好了，现在你听到的就是我的声音。";
      const test = () => { setNotice(""); enqueue(sample); };
      const togglePause = () => { if (paused) resumeAll(); else pauseAll(); };

      const chineseHost = host.voices.filter((v) => /zh|Chinese/i.test(`${v.culture} ${v.name}`));
      const chineseBrowser = voices.filter((v) => /^zh/i.test(v.lang || ""));

      const browserOk = voices.length > 0;
      const hostOk = host.ok && host.voices.filter((v) => v.enabled !== false).length > 0;

      // 音色下拉跟着"声音引擎"切：浏览器 / 本机 SAPI 各一套
      const sourceKey = state.engine === "sapi" ? "sapi" : "browser";
      const voiceOptions = sourceKey === "sapi"
        ? host.voices.map((v) => ({ value: v.name, label: `${v.name} · ${v.culture}` }))
        : voices.map((v) => ({ value: v.voiceURI, label: `${v.name} · ${v.lang}` }));
      const currentVoice = sourceKey === "sapi" ? state.hostVoice : state.voiceURI;
      const applyVoice = (value) => set(sourceKey === "sapi" ? { hostVoice: value } : { voiceURI: value });
      const voiceHint = sourceKey === "sapi"
        ? (host.loading ? "读取中…" : (host.error || `本机 SAPI 共 ${host.voices.length} 个，其中中文 ${chineseHost.length} 个`))
        : (voices.length ? `浏览器音色共 ${voices.length} 个，其中中文 ${chineseBrowser.length} 个` : "这个环境没有暴露浏览器音色，请改用 SAPI");

      const effective = cfg.engine === "browser" ? (browserOk ? "浏览器" : "无可用")
        : cfg.engine === "sapi" ? (hostOk ? "SAPI" : "无可用")
          : (browserOk ? "浏览器" : hostOk ? "SAPI" : "无可用");

      return h("div", { className: "dshv" },
        h("h2", { className: "dshv-title" }, "语音播报"),
        h("p", { className: "dshv-intro" },
          "把已经说完的回复念出来。只念你屏幕上看到的那一段，思考过程和工具调用不念，代码块默认跳过。"),

        h("div", { className: "dshv-rows" },
          h(Row, { label: "总开关", hint: "关掉就不再自动念；消息栏里的小喇叭仍然可以手点着念" },
            h(Switch, { checked: state.enabled, onChange: (value) => set({ enabled: value }) })),

          h(Row, { label: "选字阅读", hint: "选中聊天区或输入框里的任意文字，冒出一个「念这段」" },
            h(Switch, { checked: state.selection, onChange: (value) => set({ selection: value }) })),

          h(Row, { label: "朗读时自动滚动", hint: "念到屏幕外的段落时，自动把它滚进视野（你手动滚动后 3 秒内不抢）" },
            h(Switch, { checked: state.autoScroll, onChange: (value) => set({ autoScroll: value }) })),

          h(Row, { label: "声音引擎", hint: `当前实际使用：${effective}` },
            h("select", {
              className: "dshv-select",
              value: state.engine,
              onChange: (event) => set({ engine: event.target.value }),
            },
              h("option", { value: "auto" }, "自动（优先浏览器）"),
              h("option", { value: "browser" }, "浏览器 Web Speech"),
              h("option", { value: "sapi" }, "Windows SAPI（本机合成）"))),

          h(Row, { label: "音色", hint: voiceHint },
            h("select", {
              className: "dshv-select",
              value: currentVoice,
              onChange: (event) => applyVoice(event.target.value),
            },
              h("option", { value: "" }, "自动选择（优先中文）"),
              voiceOptions.map((option, index) => h("option", { key: `${option.value}-${index}`, value: option.value }, option.label)))),

          h(Row, { label: "语速", hint: `${Number(state.rate).toFixed(1)}×` },
            h("input", {
              className: "dshv-range", type: "range", min: 0.5, max: 2, step: 0.1,
              value: state.rate, onChange: (event) => set({ rate: Number(event.target.value) }),
            })),

          h(Row, { label: "音调", hint: `${Number(state.pitch).toFixed(1)}（只对浏览器引擎有效）` },
            h("input", {
              className: "dshv-range", type: "range", min: 0.5, max: 2, step: 0.1,
              value: state.pitch, onChange: (event) => set({ pitch: Number(event.target.value) }),
            })),

          h(Row, { label: "音量", hint: `${Math.round(Number(state.volume) * 100)}%` },
            h("input", {
              className: "dshv-range", type: "range", min: 0, max: 1, step: 0.05,
              value: state.volume, onChange: (event) => set({ volume: Number(event.target.value) }),
            })),

          h(Row, { label: "判定说完的静默", hint: `${state.settleMs} 毫秒；调大更稳，调小更快出声` },
            h("input", {
              className: "dshv-input", type: "number", min: 300, max: 5000, step: 100,
              value: state.settleMs, onChange: (event) => set({ settleMs: Number(event.target.value) }),
            })),

          h(Row, { label: "单句最长字数", hint: `${state.maxChars} 字；太长会切成多段念` },
            h("input", {
              className: "dshv-input", type: "number", min: 60, max: 500, step: 20,
              value: state.maxChars, onChange: (event) => set({ maxChars: Number(event.target.value) }),
            })),

          h(Row, { label: "每轮最多念多少字", hint: `${state.maxTurnChars} 字；一轮做几十步的时候不至于念到天亮` },
            h("input", {
              className: "dshv-input", type: "number", min: 100, max: 6000, step: 100,
              value: state.maxTurnChars, onChange: (event) => set({ maxTurnChars: Number(event.target.value) }),
            })),

          h(Row, { label: "跳过代码块", hint: "念代码很难听，默认跳过" },
            h(Switch, { checked: state.skipCode, onChange: (value) => set({ skipCode: value }) }))),

        h("div", { className: "dshv-actions" },
          h("button", { className: "dshv-btn", onClick: test }, isSpeaking ? "正在说话…" : "试听一句"),
          h("button", { className: "dshv-btn dshv-btn2", onClick: togglePause, disabled: !isSpeaking && !isPaused }, isPaused ? "继续" : "暂停"),
          h("button", { className: "dshv-btn dshv-btn2", onClick: () => loadHostVoices() }, host.loading ? "刷新中…" : "刷新音色"),
          h("button", {
            className: "dshv-btn dshv-btn2",
            onClick: () => {
              updateConfig({ enabled: true, engine: "auto" });
              setState({ ...cfg });
              setNotice("已恢复默认：自动引擎 + 开启播报");
            },
          }, "一键恢复默认")),

        notice ? h("div", { className: "dshv-hint" }, notice) : null,

        h("div", { className: "dshv-out" },
          `浏览器 Web Speech：${browserOk ? "可用" : "不可用"}（${voices.length} 个音色）\n`,
          `Windows SAPI：${host.loading ? "检测中" : hostOk ? "可用" : "不可用"}${host.error ? `（${host.error}）` : `（${host.voices.length} 个音色）`}\n`,
          `实际引擎：${effective}\n`,
          `自动播报：${cfg.enabled ? "开" : "关"} · 选字阅读：${cfg.selection ? "开" : "关"}${isSpeaking ? " · 正在播报" : ""}\n`,
          `最近错误：${errors.length ? errors[errors.length - 1] : "无"}`));
    }

    // ── 挂载 ───────────────────────────────────────────────────────────────
    let booted = null;

    function boot() {
      if (booted) return booted;
      injectCss();
      popoverCssProbe = probePopoverCss();
      // 热重载会在页面里留下上一版实例的浮层和按钮：它们带着旧代码和旧文案，
      // 用户点到的可能是"僵尸"。先全部清掉，再让本实例重建。
      try {
        for (const node of window.document.querySelectorAll(".dshv-pop, .dshv-chip, .dshv-act")) node.remove();
      } catch { /* 清不掉就算了 */ }
      startWatching();
      sweepRowActions();
      rowSweep = window.setInterval(sweepRowActions, 600);
      // 设置页是懒加载的：等它渲染出来再把导航图标换成人头说话
      patchNavIcon();
      navSweep = window.setInterval(patchNavIcon, 800);
      // 心跳：每 30 秒把当前自检状态落一次盘，页面不动也能查到真实状态。
      heartBeat = window.setInterval(() => report({ heartbeat: true }, true), 30000);
      const disposeSelection = installSelectionReader();
      trace(`boot v${CLIENT_VERSION}: enabled=${cfg.enabled} 上限=${cfg.maxTurnChars}字 浏览器音色=${browserVoices().length}`);
      report({ watching: true }, true);
      probe();
      // 播报开关 + 首次问候：真出过声才算"打过招呼"，否则下次刷新还会再试一次
      // （只认成功，不认"我发过请求了"——静音失败的时候用户得知道）。
      if (cfg.enabled && !cfg.greetedOk) {
        trace("greeting scheduled");
        window.setTimeout(() => {
          updateConfig({ greeted: true });
          trace("greeting firing");
          enqueue("语音播报已经装好了。我现在可以把我回复的内容念给你听。");
        }, 1600);
      }

      booted = () => {
        stopWatching();
        stopAll();
        closePopover();
        if (rowSweep) { window.clearInterval(rowSweep); rowSweep = null; }
        if (heartBeat) { window.clearInterval(heartBeat); heartBeat = null; }
        if (navSweep) { window.clearInterval(navSweep); navSweep = null; }
        try { disposeSelection(); } catch { /* 已摘掉 */ }
        for (const node of ownButtons) { try { node.remove(); } catch { /* 已摘掉 */ } }
        ownButtons.clear();
        try { popover && popover.remove(); } catch { /* 已摘掉 */ }
        popover = null;
        booted = null;
      };
      return booted;
    }

    exports.inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() => boot(), "dsh-voice: 播报与悬浮按钮");
      ctx.effect(
        () => ctx.slots.inject("settings.section", () => ctx.slots.register(
          { name: "settings.section", id: "voice", order: 7, label: () => "语音播报" },
          VoiceSection,
        ), "dsh-voice: settings section"),
        "dsh-voice: settings section",
      );
    }

    exports.apply = apply;
    exports.VoiceSection = VoiceSection;
    // 给测试用：纯逻辑单独导出，方便在 Node 里跑（不需要真浏览器）
    exports.__internals = { cleanText, splitSpeech, collectText, loadConfig, DEFAULTS, watch, audio, config: () => cfg, setConfig: updateConfig, speakNow, sweepRowActions, turnTextFrom, turnBlocksFrom, blocksOf, detectTheme, parseColor, pauseAll, resumeAll, isPaused: () => paused, readingEl: () => readingEl };

    return module.exports;
  },
});