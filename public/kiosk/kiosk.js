'use strict';
// Aplicativo do quiosque (tablet). Fluxo:
//   pareamento (uma vez) → boas-vindas → perguntas → agradecimento → boas-vindas ...
// Não há menus nem navegação: o cliente só vê a pesquisa.
(() => {
  const TOKEN_KEY = 'kiosk.token';
  const CONFIG_KEY = 'kiosk.config';
  const QUEUE_KEY = 'kiosk.queue';
  const CONFIG_REFRESH_MS = 60_000;
  const FLUSH_MS = 30_000;

  const app = document.getElementById('app');
  const offlineBar = document.getElementById('offline');
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* armazenamento cheio */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };

  let config = store.get(CONFIG_KEY);
  let state = null;          // pesquisa em andamento
  let idleTimer = null;
  let thanksTimer = null;
  let screen = 'boot';

  // ------------------------------------------------------------ utilidades de DOM (sem innerHTML)
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const SCALE5_LABELS = ['Péssimo', 'Ruim', 'Regular', 'Bom', 'Ótimo'];

  // Escala 0–10 (NPS) ou 1–5 em três estilos: números, carinhas ou ícones.
  // O valor salvo é sempre o número, então o cálculo do NPS não muda com o estilo.
  function ratingScale(q, value, choose) {
    const isNps = q.type === 'nps';
    const values = isNps ? Array.from({ length: 11 }, (_, n) => n) : [1, 2, 3, 4, 5];
    const b = config?.branding || {};
    // "default" = segue o estilo escolhido em Configurações → Ícones das respostas.
    const display = !q.display || q.display === 'default' ? (b.defaultDisplay || 'numbers') : q.display;
    const icon = q.icon || b.ratingIcon || 'star';
    const color = (n) => window.Icons.levelColor(n, isNps, b.colorScheme);
    const cls = `rating rating-${display} ${isNps ? 'rating-11' : 'rating-5'}`;
    const buttons = values.map((n) => {
      const selected = value === n;
      const label = isNps ? `Nota ${n}` : SCALE5_LABELS[n - 1];
      let content;
      if (display === 'faces') {
        content = [window.Icons.face(window.Icons.levelT(n, isNps), { color: color(n), mono: b.faceStyle === 'mono' }),
          h('span', { class: 'r-num' }, isNps ? String(n) : SCALE5_LABELS[n - 1])];
      } else if (display === 'icons') {
        const filled = value !== undefined && n <= value && n > 0;
        content = [window.Icons.svg(icon, { size: 48, fill: filled, cls: 'r-icon' + (filled ? ' on' : '') }), h('span', { class: 'r-num' }, isNps ? String(n) : SCALE5_LABELS[n - 1])];
      } else {
        content = [h('span', { class: 'r-big' }, String(n))];
      }
      const btn = h('button', { class: `r-btn${selected ? ' selected' : ''}`, onclick: () => choose(n), 'aria-label': label }, ...content);
      if (display === 'numbers') btn.style.background = color(n);
      return btn;
    });
    return h('div', { class: 'rating-wrap' }, h('div', { class: cls }, ...buttons),
      isNps ? h('div', { class: 'nps-legend' }, h('span', {}, 'Nada provável'), h('span', {}, 'Extremamente provável'))
        : display === 'numbers' ? h('div', { class: 'nps-legend' }, h('span', {}, 'Péssimo'), h('span', {}, 'Ótimo')) : null);
  }

  // Aplica cores e logo definidas em Configurações.
  function applyBranding() {
    const b = config?.branding;
    if (!b) return;
    const root = document.documentElement.style;
    root.setProperty('--bg', b.primaryColor);
    root.setProperty('--bg2', `color-mix(in srgb, ${b.primaryColor} 78%, white)`);
    root.setProperty('--accent', b.accentColor);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', b.primaryColor);
    document.title = b.companyName;
  }
  const logoEl = (cls) => (config?.branding?.logoUrl ? h('img', { class: cls, src: config.branding.logoUrl, alt: config.branding.companyName }) : null);

  function render(name, ...nodes) {
    screen = name;
    app.replaceChildren(...nodes);
    app.dataset.screen = name;
  }

  // ------------------------------------------------------------ API
  async function api(path, opts = {}) {
    const token = store.get(TOKEN_KEY);
    const res = await fetch('/api/kiosk' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Erro'); e.status = res.status; throw e; }
    return data;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  // ------------------------------------------------------------ pareamento
  function showPairing(message) {
    const input = h('input', { class: 'pair-input', maxlength: '12', autocomplete: 'off', autocapitalize: 'characters',
      spellcheck: 'false', placeholder: 'XXXXXXXX', 'aria-label': 'Código de pareamento' });
    const err = h('p', { class: 'pair-error', role: 'alert' }, message || '');
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Ativar este tablet');
    const form = h('form', { class: 'pair-form', onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      try {
        const { token } = await api('/pair', { method: 'POST', body: { code: input.value } });
        store.set(TOKEN_KEY, token);
        await loadConfig();
        showWelcome();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    } }, input, btn, err);
    render('pair', h('div', { class: 'card pair' },
      h('h1', {}, 'Ativar tablet'),
      h('p', { class: 'muted' }, 'No painel administrativo, acesse Dispositivos, cadastre este tablet na filial correta e digite aqui o código gerado.'),
      form));
    setTimeout(() => input.focus(), 50);
  }

  // ------------------------------------------------------------ configuração
  async function loadConfig() {
    const c = await api('/config');
    const changed = JSON.stringify(c) !== JSON.stringify(config);
    config = c;
    store.set(CONFIG_KEY, c);
    applyBranding();
    return changed;
  }

  async function refreshConfig() {
    try {
      const changed = await loadConfig();
      setOnline(true);
      if (changed && ['welcome', 'unavailable', 'offline'].includes(screen)) showWelcome();
    } catch (e) {
      if (e.status === 401) return unpair('Este tablet foi desativado no painel. Gere um novo código para reativá-lo.');
      setOnline(false);
    }
  }

  function unpair(message) {
    store.del(TOKEN_KEY); store.del(CONFIG_KEY);
    config = null; state = null;
    showPairing(message);
  }

  // ------------------------------------------------------------ telas
  function showWelcome() {
    clearTimers();
    state = null;
    if (!config || !config.survey) return showUnavailable();
    const s = config.survey;
    render('welcome', h('button', { class: 'welcome', onclick: startSurvey },
      h('div', { class: 'welcome-inner' },
        logoEl('welcome-logo'),
        h('h1', { class: 'welcome-title' }, s.welcomeTitle),
        s.welcomeText ? h('p', { class: 'welcome-text' }, s.welcomeText) : null,
        h('span', { class: 'btn btn-primary btn-xl pulse' }, 'Toque para começar')),
      h('div', { class: 'branch-tag' }, config.branch.name)));
  }

  function showUnavailable() {
    render('unavailable', h('div', { class: 'card center' },
      h('h1', {}, 'Pesquisa indisponível no momento'),
      h('p', { class: 'muted' }, 'Nenhuma pesquisa ativa para esta filial.')));
  }

  function startSurvey() {
    requestFullscreen();
    state = { uuid: uuid(), startedAt: Date.now(), index: 0, answers: {}, survey: config.survey };
    showQuestion();
  }

  function bumpIdle() {
    if (!state) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showWelcome, (state.survey.idleSeconds || 45) * 1000);
  }

  function clearTimers() { clearTimeout(idleTimer); clearTimeout(thanksTimer); }

  function showQuestion() {
    bumpIdle();
    const s = state.survey;
    const q = s.questions[state.index];
    const total = s.questions.length;
    const isLast = state.index === total - 1;
    const value = state.answers[q.id];

    const next = () => {
      if (isLast) return submit();
      state.index++; showQuestion();
    };
    const choose = (v, auto = true) => {
      state.answers[q.id] = v;
      bumpIdle();
      showQuestion();
      if (auto) setTimeout(() => { if (state && state.survey.questions[state.index] === q) next(); }, 350);
    };

    let body;
    if (q.type === 'nps' || q.type === 'scale5') {
      body = ratingScale(q, value, choose);
    } else if (q.type === 'yesno') {
      body = h('div', { class: 'choices two' },
        h('button', { class: `choice${value === 'sim' ? ' selected' : ''}`, onclick: () => choose('sim') }, 'Sim'),
        h('button', { class: `choice${value === 'nao' ? ' selected' : ''}`, onclick: () => choose('nao') }, 'Não'));
    } else if (q.type === 'single') {
      body = h('div', { class: 'choices' }, ...q.options.map((o) => h('button', {
        class: `choice${value === o ? ' selected' : ''}`, onclick: () => choose(o) }, o)));
    } else if (q.type === 'multi') {
      const sel = new Set(value || []);
      body = h('div', { class: 'choices' }, ...q.options.map((o) => h('button', {
        class: `choice check${sel.has(o) ? ' selected' : ''}`,
        onclick: () => { sel.has(o) ? sel.delete(o) : sel.add(o); choose([...sel], false); },
      }, o)));
    } else if (q.type === 'text') {
      const ta = h('textarea', { class: 'text-answer', maxlength: '1000', rows: '4', placeholder: 'Escreva aqui (opcional)…' });
      ta.value = value || '';
      ta.addEventListener('input', () => { state.answers[q.id] = ta.value; bumpIdle(); updateNext(); });
      body = h('div', { class: 'text-wrap' }, ta);
    }

    const answered = () => {
      const v = state.answers[q.id];
      return !(v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim()));
    };
    const nextBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => { if (answered() || !q.required) next(); } });
    function updateNext() {
      const ok = answered();
      nextBtn.disabled = q.required && !ok;
      nextBtn.textContent = isLast ? 'Enviar' : (!ok && !q.required ? 'Pular' : 'Avançar');
    }
    updateNext();
    const showNext = ['multi', 'text'].includes(q.type) || !q.required || value !== undefined;

    render('question', h('div', { class: 'question' },
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(state.index + 1) },
        h('div', { class: 'progress-bar', style: null })),
      h('div', { class: 'q-head' },
        h('span', { class: 'q-count' }, `${state.index + 1} de ${total}`),
        h('h1', { class: 'q-text' }, q.text),
        q.helpText ? h('p', { class: 'q-help' }, q.helpText) : null),
      h('div', { class: 'q-body' }, body),
      h('div', { class: 'q-nav' },
        state.index > 0 ? h('button', { class: 'btn btn-ghost btn-lg', onclick: () => { state.index--; showQuestion(); } }, 'Voltar') : h('span'),
        showNext ? nextBtn : h('span'))));
    // CSP proíbe atributo style inline; a largura é ajustada pelo CSSOM.
    app.querySelector('.progress-bar').style.width = `${((state.index + 1) / total) * 100}%`;
    if (q.type === 'text') setTimeout(() => app.querySelector('textarea')?.focus(), 50);
  }

  function submit() {
    const s = state.survey;
    const payload = {
      uuid: state.uuid,
      surveyId: s.id,
      startedAt: state.startedAt,
      submittedAt: Date.now(),
      answers: s.questions
        .filter((q) => state.answers[q.id] !== undefined && !(q.type === 'text' && !String(state.answers[q.id]).trim()))
        .map((q) => ({ questionId: q.id, value: q.type === 'text' ? String(state.answers[q.id]).trim() : state.answers[q.id] })),
    };
    const queue = store.get(QUEUE_KEY, []);
    queue.push(payload);
    store.set(QUEUE_KEY, queue.slice(-500));
    showThanks();
    flushQueue();
  }

  function showThanks() {
    clearTimers();
    const s = state.survey;
    state = null;
    let media = null;
    if (s.thanksMedia?.kind === 'image') media = h('img', { class: 'thanks-media', src: s.thanksMedia.url, alt: '' });
    if (s.thanksMedia?.kind === 'video') {
      media = h('video', { class: 'thanks-media', src: s.thanksMedia.url, autoplay: true, muted: true, playsinline: true, loop: true });
      media.muted = true;
    }
    render('thanks', h('div', { class: 'thanks' },
      media || logoEl('thanks-logo'),
      h('h1', { class: 'thanks-title' }, s.thanksTitle),
      s.thanksText ? h('p', { class: 'thanks-text' }, s.thanksText) : null));
    thanksTimer = setTimeout(showWelcome, (s.thanksSeconds || 8) * 1000);
  }

  // ------------------------------------------------------------ fila offline
  let flushing = false;
  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      let queue = store.get(QUEUE_KEY, []);
      while (queue.length) {
        const item = queue[0];
        try {
          await api('/responses', { method: 'POST', body: item });
        } catch (e) {
          if (e.status === 401) { setOnline(true); break; }
          if (!e.status || e.status === 429 || e.status >= 500) { setOnline(!!e.status); break; } // tenta depois
          console.warn('Resposta descartada pelo servidor:', e.message); // 400/409: inválida, não adianta reenviar
        }
        queue = store.get(QUEUE_KEY, []).filter((x) => x.uuid !== item.uuid);
        store.set(QUEUE_KEY, queue);
        setOnline(true);
      }
    } finally { flushing = false; }
  }

  function setOnline(on) { offlineBar.classList.toggle('hidden', on); }

  // ------------------------------------------------------------ travas de quiosque
  function requestFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    // bloqueia atalhos de recarregar/abrir ferramentas quando há teclado físico
    if (e.key === 'F5' || (e.ctrlKey && ['r', 'R', 'p', 'P', 's', 'S'].includes(e.key)) || e.key === 'F12') e.preventDefault();
  });
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  // Menu técnico oculto: 7 toques rápidos no canto superior esquerdo.
  let taps = [];
  document.getElementById('secret').addEventListener('click', () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 3000).concat(now);
    if (taps.length >= 7) { taps = []; showTech(); }
  });
  function showTech() {
    clearTimers();
    const q = store.get(QUEUE_KEY, []);
    render('tech', h('div', { class: 'card' },
      h('h1', {}, 'Informações do tablet'),
      h('p', {}, `Dispositivo: ${config?.device?.name || '-'}`),
      h('p', {}, `Filial: ${config?.branch?.name || '-'}`),
      h('p', {}, `Respostas aguardando envio: ${q.length}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => { flushQueue(); refreshConfig().then(showWelcome); } }, 'Sincronizar e voltar'),
        h('button', { class: 'btn btn-ghost', onclick: showWelcome }, 'Fechar'))));
    setTimeout(() => { if (screen === 'tech') showWelcome(); }, 30_000);
  }

  // ------------------------------------------------------------ inicialização
  async function boot() {
    applyBranding();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/kiosk/sw.js', { scope: '/kiosk/' }).catch(() => {});
    keepAwake();
    if (!store.get(TOKEN_KEY)) return showPairing();
    await refreshConfig();
    if (!store.get(TOKEN_KEY)) return; // foi despareado
    if (config) showWelcome(); else render('offline', h('div', { class: 'card center' }, h('h1', {}, 'Conectando…')));
  }

  // Sincronização em segundo plano: roda sempre, inclusive em um tablet recém-pareado.
  function startBackgroundSync() {
    setInterval(() => {
      if (store.get(TOKEN_KEY) && ['welcome', 'unavailable', 'offline'].includes(screen)) refreshConfig();
    }, CONFIG_REFRESH_MS);
    setInterval(() => { if (store.get(TOKEN_KEY)) flushQueue(); }, FLUSH_MS);
    window.addEventListener('online', () => { if (store.get(TOKEN_KEY)) flushQueue(); });
  }

  startBackgroundSync();
  boot().then(() => { if (store.get(TOKEN_KEY)) flushQueue(); });
})();
