'use strict';
// Aplicativo de coleta. Dois modos:
//   • Tablet (/kiosk/): pareamento → boas-vindas → perguntas → [contato] → agradecimento → boas-vindas ...
//   • Link/QR Code (/r/<código>): o cliente responde no próprio celular, uma vez, sem pareamento.
// Não há menus nem navegação: o cliente só vê a pesquisa.
(() => {
  const LINK = /^\/r\/([A-Za-z0-9_-]{20,64})\/?$/.exec(location.pathname);
  const MODE = LINK ? 'link' : 'tablet';
  const TOKEN_KEY = 'kiosk.token';
  const CONFIG_KEY = MODE === 'link' ? 'link.config' : 'kiosk.config';
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

  let config = MODE === 'tablet' ? store.get(CONFIG_KEY) : null;
  let state = null;          // pesquisa em andamento
  let idleTimer = null;
  let thanksTimer = null;
  let screen = 'boot';
  let lang = 'pt';

  // ------------------------------------------------------------ textos da interface (pt/en/es)
  const UI = {
    pt: { start: 'Toque para começar', of: 'de', back: 'Voltar', next: 'Avançar', skip: 'Pular', send: 'Enviar', low: 'Nada provável', high: 'Extremamente provável',
      scale5: ['Péssimo', 'Ruim', 'Regular', 'Bom', 'Ótimo'], yes: 'Sim', no: 'Não', write: 'Escreva aqui (opcional)…', privacy: 'Privacidade',
      contactAsk: 'Gostaria que entrássemos em contato com você?', contactWhy: 'Queremos entender melhor e resolver o que aconteceu.',
      contactYes: 'Sim, quero contato', contactNo: 'Não, obrigado', name: 'Nome (opcional)', phone: 'Telefone / WhatsApp', email: 'E-mail',
      consent: 'Autorizo o uso destes dados somente para contato sobre esta avaliação.', needOne: 'Informe telefone ou e-mail.', needConsent: 'Marque a autorização para continuar.',
      close: 'Fechar', closed: 'Estamos fechados no momento', unavailable: 'Pesquisa indisponível no momento', noSurvey: 'Nenhuma pesquisa ativa para esta filial.',
      once: 'Esta avaliação já foi enviada. Obrigado!', error: 'Não foi possível enviar. Verifique a internet e tente de novo.', retry: 'Tentar de novo' },
    en: { start: 'Tap to start', of: 'of', back: 'Back', next: 'Next', skip: 'Skip', send: 'Send', low: 'Not likely', high: 'Extremely likely',
      scale5: ['Very bad', 'Bad', 'Fair', 'Good', 'Excellent'], yes: 'Yes', no: 'No', write: 'Write here (optional)…', privacy: 'Privacy',
      contactAsk: 'Would you like us to contact you?', contactWhy: 'We want to understand and fix what happened.',
      contactYes: 'Yes, contact me', contactNo: 'No, thanks', name: 'Name (optional)', phone: 'Phone / WhatsApp', email: 'E-mail',
      consent: 'I authorize the use of this data only to contact me about this feedback.', needOne: 'Enter a phone or e-mail.', needConsent: 'Please check the authorization to continue.',
      close: 'Close', closed: 'We are closed right now', unavailable: 'Survey unavailable right now', noSurvey: 'No active survey for this location.',
      once: 'This feedback was already sent. Thank you!', error: 'Could not send. Check your connection and try again.', retry: 'Try again' },
    es: { start: 'Toque para empezar', of: 'de', back: 'Volver', next: 'Siguiente', skip: 'Omitir', send: 'Enviar', low: 'Nada probable', high: 'Muy probable',
      scale5: ['Pésimo', 'Malo', 'Regular', 'Bueno', 'Excelente'], yes: 'Sí', no: 'No', write: 'Escriba aquí (opcional)…', privacy: 'Privacidad',
      contactAsk: '¿Desea que nos pongamos en contacto?', contactWhy: 'Queremos entender y resolver lo que pasó.',
      contactYes: 'Sí, quiero contacto', contactNo: 'No, gracias', name: 'Nombre (opcional)', phone: 'Teléfono / WhatsApp', email: 'Correo',
      consent: 'Autorizo el uso de estos datos solo para contactarme sobre esta evaluación.', needOne: 'Ingrese teléfono o correo.', needConsent: 'Marque la autorización para continuar.',
      close: 'Cerrar', closed: 'Estamos cerrados en este momento', unavailable: 'Encuesta no disponible', noSurvey: 'No hay encuesta activa para esta tienda.',
      once: 'Esta evaluación ya fue enviada. ¡Gracias!', error: 'No se pudo enviar. Verifique la conexión e intente de nuevo.', retry: 'Intentar de nuevo' },
  };
  const LANG_NAMES = { pt: 'Português', en: 'English', es: 'Español' };
  const t = (k) => (UI[lang] || UI.pt)[k] ?? UI.pt[k];
  // Texto no idioma escolhido (cai no português se não houver tradução).
  const qt = (q, field) => q.i18n?.[lang]?.[field] || q[field];
  const optLabel = (q, o) => { const i = q.options.indexOf(o); return q.i18n?.[lang]?.options?.[i] || o; };

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

  // Escala 0–10 (NPS) ou 1–5 em três estilos: números, carinhas ou ícones.
  // O valor salvo é sempre o número, então o cálculo do NPS não muda com o estilo.
  function ratingScale(q, value, choose) {
    const isNps = q.type === 'nps';
    const values = isNps ? Array.from({ length: 11 }, (_, n) => n) : [1, 2, 3, 4, 5];
    const b = config?.branding || {};
    const display = !q.display || q.display === 'default' ? (b.defaultDisplay || 'numbers') : q.display;
    const icon = q.icon || b.ratingIcon || 'star';
    const color = (n) => window.Icons.levelColor(n, isNps, b.colorScheme);
    const labels = t('scale5');
    const cls = `rating rating-${display} ${isNps ? 'rating-11' : 'rating-5'}`;
    const buttons = values.map((n) => {
      const selected = value === n;
      let content;
      if (display === 'faces') {
        content = [window.Icons.face(window.Icons.levelT(n, isNps), { color: color(n), mono: b.faceStyle === 'mono' }),
          h('span', { class: 'r-num' }, isNps ? String(n) : labels[n - 1])];
      } else if (display === 'icons') {
        const filled = value !== undefined && n <= value && n > 0;
        content = [window.Icons.svg(icon, { size: 48, fill: filled, cls: 'r-icon' + (filled ? ' on' : '') }), h('span', { class: 'r-num' }, isNps ? String(n) : labels[n - 1])];
      } else {
        content = [h('span', { class: 'r-big' }, String(n))];
      }
      const btn = h('button', { class: `r-btn${selected ? ' selected' : ''}`, onclick: () => choose(n), 'aria-label': isNps ? String(n) : labels[n - 1] }, ...content);
      if (display === 'numbers') btn.style.background = color(n);
      return btn;
    });
    return h('div', { class: 'rating-wrap' }, h('div', { class: cls }, ...buttons),
      isNps ? h('div', { class: 'nps-legend' }, h('span', {}, t('low')), h('span', {}, t('high')))
        : display === 'numbers' ? h('div', { class: 'nps-legend' }, h('span', {}, labels[0]), h('span', {}, labels[4])) : null);
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
    const base = MODE === 'link' ? `/api/link/${LINK[1]}` : '/api/kiosk';
    const token = MODE === 'tablet' ? store.get(TOKEN_KEY) : null;
    const res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
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

  // ------------------------------------------------------------ pareamento (somente tablet)
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
      h('p', { class: 'muted' }, 'No painel administrativo, acesse Tablets, cadastre este tablet na filial correta e digite aqui o código gerado.'),
      form));
    setTimeout(() => input.focus(), 50);
  }

  // ------------------------------------------------------------ configuração
  async function loadConfig() {
    const c = await api('/config');
    const comparable = (x) => JSON.stringify({ ...x, ticket: undefined });
    const changed = comparable(c) !== comparable(config);
    config = c;
    if (MODE === 'tablet') store.set(CONFIG_KEY, c);
    applyBranding();
    return changed;
  }

  async function refreshConfig() {
    try {
      const changed = await loadConfig();
      setOnline(true);
      if (changed && ['welcome', 'unavailable', 'offline', 'closed'].includes(screen)) showWelcome();
    } catch (e) {
      if (e.status === 401 && MODE === 'tablet') return unpair('Este tablet foi desativado no painel. Gere um novo código para reativá-lo.');
      setOnline(false);
    }
  }

  function unpair(message) {
    store.del(TOKEN_KEY); store.del(CONFIG_KEY);
    config = null; state = null;
    showPairing(message);
  }

  // ------------------------------------------------------------ privacidade (LGPD)
  function privacyLink() {
    if (!config?.branding?.privacyText) return null;
    return h('button', { class: 'privacy-link', onclick: (e) => { e.stopPropagation(); showPrivacy(); } }, t('privacy'));
  }
  function showPrivacy() {
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
      h('div', { class: 'card' }, h('h2', {}, t('privacy')), h('p', { class: 'privacy-text' }, config.branding.privacyText),
        h('button', { class: 'btn btn-primary', onclick: () => overlay.remove() }, t('close'))));
    document.body.append(overlay);
  }

  // ------------------------------------------------------------ telas
  function showWelcome() {
    clearTimers();
    state = null;
    document.querySelector('.overlay')?.remove();
    if (!config || !config.survey) return showUnavailable();
    if (config.open === false) return showClosed();
    const s = config.survey;
    if (!s.languages?.includes(lang)) lang = 'pt';
    const langs = (s.languages || ['pt']).length > 1 ? h('div', { class: 'lang-bar' }, s.languages.map((l) => h('button', {
      class: 'lang' + (l === lang ? ' active' : ''), onclick: (e) => { e.stopPropagation(); lang = l; showWelcome(); } }, LANG_NAMES[l]))) : null;
    render('welcome', h('div', { class: 'welcome-wrap' }, langs,
      h('button', { class: 'welcome', onclick: startSurvey },
        h('div', { class: 'welcome-inner' },
          logoEl('welcome-logo'),
          h('h1', { class: 'welcome-title' }, s.i18n?.[lang]?.welcome_title || s.welcomeTitle),
          (s.i18n?.[lang]?.welcome_text || s.welcomeText) ? h('p', { class: 'welcome-text' }, s.i18n?.[lang]?.welcome_text || s.welcomeText) : null,
          h('span', { class: 'btn btn-primary btn-xl pulse' }, t('start'))),
        MODE === 'tablet' ? h('div', { class: 'branch-tag' }, config.branch.name) : null),
      privacyLink()));
  }

  function showUnavailable() {
    render('unavailable', h('div', { class: 'card center' },
      h('h1', {}, t('unavailable')),
      h('p', { class: 'muted' }, t('noSurvey'))));
  }

  // Fora do horário de funcionamento da filial: tela de descanso.
  function showClosed() {
    render('closed', h('div', { class: 'closed' }, logoEl('welcome-logo'),
      h('h1', {}, t('closed')), config.reopens ? h('p', {}, config.reopens) : null));
  }

  function startSurvey() {
    if (MODE === 'tablet') requestFullscreen();
    state = { uuid: uuid(), startedAt: Date.now(), index: -1, answers: {}, survey: config.survey, ticket: config.ticket };
    goNext();
  }

  function bumpIdle() {
    if (!state || MODE === 'link') return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showWelcome, (state.survey.idleSeconds || 45) * 1000);
  }

  function clearTimers() { clearTimeout(idleTimer); clearTimeout(thanksTimer); }

  // ------------------------------------------------------------ perguntas condicionais
  function condOk(cond, v) {
    if (v === undefined || v === null || v === '') return false;
    switch (cond.op) {
      case 'lte': return v <= cond.value;
      case 'gte': return v >= cond.value;
      case 'eq': return v === cond.value;
      case 'in': return Array.isArray(cond.value) && cond.value.includes(v);
      case 'has': return Array.isArray(v) && v.includes(cond.value);
      default: return false;
    }
  }
  // Visível se não tem condição ou se a pergunta de referência (também visível) atende a condição.
  function visible(i) {
    const q = state.survey.questions[i];
    if (!q.showIf) return true;
    const ref = state.survey.questions.findIndex((x) => x.id === q.showIf.q);
    return ref >= 0 && ref < i && visible(ref) && condOk(q.showIf, state.answers[q.showIf.q]);
  }
  const visibleIdx = () => state.survey.questions.map((_, i) => i).filter(visible);

  function goNext() {
    const next = visibleIdx().find((i) => i > state.index);
    if (next === undefined) return finish();
    state.index = next; showQuestion();
  }
  function goBack() {
    const prev = visibleIdx().filter((i) => i < state.index).pop();
    if (prev !== undefined) { state.index = prev; showQuestion(); }
  }

  function showQuestion() {
    bumpIdle();
    const s = state.survey;
    const q = s.questions[state.index];
    const vis = visibleIdx();
    const pos = vis.indexOf(state.index);
    const total = vis.length;
    const isLast = pos === total - 1;
    const value = state.answers[q.id];
    const help = q.i18n?.[lang]?.help_text || q.helpText;

    const choose = (v, auto = true) => {
      state.answers[q.id] = v;
      bumpIdle();
      showQuestion();
      if (auto) setTimeout(() => { if (state && state.survey.questions[state.index] === q) goNext(); }, 350);
    };

    let body;
    if (q.type === 'nps' || q.type === 'scale5') {
      body = ratingScale(q, value, choose);
    } else if (q.type === 'yesno') {
      body = h('div', { class: 'choices two' },
        h('button', { class: `choice${value === 'sim' ? ' selected' : ''}`, onclick: () => choose('sim') }, t('yes')),
        h('button', { class: `choice${value === 'nao' ? ' selected' : ''}`, onclick: () => choose('nao') }, t('no')));
    } else if (q.type === 'single') {
      body = h('div', { class: 'choices' }, ...q.options.map((o) => h('button', {
        class: `choice${value === o ? ' selected' : ''}`, onclick: () => choose(o) }, optLabel(q, o))));
    } else if (q.type === 'multi') {
      const sel = new Set(value || []);
      body = h('div', { class: 'choices' }, ...q.options.map((o) => h('button', {
        class: `choice check${sel.has(o) ? ' selected' : ''}`,
        onclick: () => { sel.has(o) ? sel.delete(o) : sel.add(o); choose([...sel], false); },
      }, optLabel(q, o))));
    } else if (q.type === 'text') {
      const ta = h('textarea', { class: 'text-answer', maxlength: '1000', rows: '4', placeholder: t('write') });
      ta.value = value || '';
      ta.addEventListener('input', () => { state.answers[q.id] = ta.value; bumpIdle(); updateNext(); });
      body = h('div', { class: 'text-wrap' }, ta);
    }

    const answered = () => {
      const v = state.answers[q.id];
      return !(v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim()));
    };
    const nextBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => { if (answered() || !q.required) goNext(); } });
    function updateNext() {
      const ok = answered();
      nextBtn.disabled = q.required && !ok;
      nextBtn.textContent = isLast && !needsContact() ? t('send') : (!ok && !q.required ? t('skip') : t('next'));
    }
    updateNext();
    const showNext = ['multi', 'text'].includes(q.type) || !q.required || value !== undefined;

    render('question', h('div', { class: 'question' },
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(pos + 1) },
        h('div', { class: 'progress-bar' })),
      h('div', { class: 'q-head' },
        h('span', { class: 'q-count' }, `${pos + 1} ${t('of')} ${total}`),
        h('h1', { class: 'q-text' }, qt(q, 'text')),
        help ? h('p', { class: 'q-help' }, help) : null),
      h('div', { class: 'q-body' }, body),
      h('div', { class: 'q-nav' },
        pos > 0 ? h('button', { class: 'btn btn-ghost btn-lg', onclick: goBack }, t('back')) : h('span'),
        showNext ? nextBtn : h('span'))));
    // CSP proíbe atributo style inline; a largura é ajustada pelo CSSOM.
    app.querySelector('.progress-bar').style.width = `${((pos + 1) / total) * 100}%`;
    if (q.type === 'text') setTimeout(() => app.querySelector('textarea')?.focus(), 50);
  }

  // ------------------------------------------------------------ contato (com consentimento — LGPD)
  function minNps() {
    const scores = state.survey.questions.filter((q, i) => q.type === 'nps' && visible(i) && Number.isInteger(state.answers[q.id])).map((q) => state.answers[q.id]);
    return scores.length ? Math.min(...scores) : null;
  }
  function needsContact() {
    const mode = state?.survey.contactMode;
    if (mode === 'always') return true;
    if (mode === 'detractors') { const m = minNps(); return m !== null && m <= 6; }
    return false;
  }

  function finish() {
    if (needsContact() && state.contact === undefined) return showContactAsk();
    submit();
  }

  function showContactAsk() {
    bumpIdle();
    render('contact', h('div', { class: 'contact' },
      h('h1', { class: 'q-text' }, t('contactAsk')), h('p', { class: 'q-help' }, t('contactWhy')),
      h('div', { class: 'choices two' },
        h('button', { class: 'choice', onclick: showContactForm }, t('contactYes')),
        h('button', { class: 'choice', onclick: () => { state.contact = null; submit(); } }, t('contactNo')))));
  }

  function showContactForm() {
    bumpIdle();
    const name = h('input', { class: 'field', maxlength: '100', autocomplete: 'off' });
    const phone = h('input', { class: 'field', type: 'tel', inputmode: 'tel', maxlength: '20', autocomplete: 'off' });
    const email = h('input', { class: 'field', type: 'email', inputmode: 'email', maxlength: '254', autocomplete: 'off' });
    const consent = h('input', { type: 'checkbox', class: 'consent-box' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    [name, phone, email].forEach((i) => i.addEventListener('input', () => { bumpIdle(); err.textContent = ''; }));
    consent.addEventListener('change', () => { err.textContent = ''; });
    render('contact', h('div', { class: 'contact' },
      h('h1', { class: 'q-text' }, t('contactAsk')),
      h('div', { class: 'contact-form' },
        h('label', {}, t('name'), name), h('label', {}, t('phone'), phone), h('label', {}, t('email'), email),
        h('label', { class: 'consent' }, consent, h('span', {}, t('consent'), ' ', privacyLink())), err),
      h('div', { class: 'q-nav' },
        h('button', { class: 'btn btn-ghost btn-lg', onclick: showContactAsk }, t('back')),
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => {
          if (!phone.value.trim() && !email.value.trim()) { err.textContent = t('needOne'); return; }
          if (!consent.checked) { err.textContent = t('needConsent'); return; }
          state.contact = { name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(), consent: true };
          submit();
        } }, t('send')))));
    setTimeout(() => name.focus(), 50);
  }

  // ------------------------------------------------------------ envio
  function buildPayload() {
    const s = state.survey;
    return {
      uuid: state.uuid,
      surveyId: s.id,
      startedAt: state.startedAt,
      submittedAt: Date.now(),
      lang,
      ticket: state.ticket,
      contact: state.contact || undefined,
      // Só envia respostas de perguntas visíveis (condicionais escondidas são descartadas).
      answers: s.questions
        .filter((q, i) => visible(i) && state.answers[q.id] !== undefined && !(q.type === 'text' && !String(state.answers[q.id]).trim()))
        .filter((q) => !(Array.isArray(state.answers[q.id]) && !state.answers[q.id].length))
        .map((q) => ({ questionId: q.id, value: q.type === 'text' ? String(state.answers[q.id]).trim() : state.answers[q.id] })),
    };
  }

  async function submit() {
    const payload = buildPayload();
    if (MODE === 'link') {
      render('sending', h('div', { class: 'card center' }, h('div', { class: 'spinner' })));
      try { await api('/responses', { method: 'POST', body: payload }); showThanks(); } catch (e) {
        render('error', h('div', { class: 'card center' }, h('p', {}, e.status === 409 || e.status === 400 ? e.message : t('error')),
          h('button', { class: 'btn btn-primary', onclick: submit }, t('retry'))));
      }
      return;
    }
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
      h('h1', { class: 'thanks-title' }, s.i18n?.[lang]?.thanks_title || s.thanksTitle),
      (s.i18n?.[lang]?.thanks_text || s.thanksText) ? h('p', { class: 'thanks-text' }, s.i18n?.[lang]?.thanks_text || s.thanksText) : null));
    // No celular (link), a tela de agradecimento fica; no tablet, volta ao início para o próximo cliente.
    if (MODE === 'tablet') thanksTimer = setTimeout(() => { lang = 'pt'; showWelcome(); }, (s.thanksSeconds || 8) * 1000);
  }

  // ------------------------------------------------------------ fila offline (somente tablet)
  let flushing = false;
  async function flushQueue() {
    if (flushing || MODE !== 'tablet') return;
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

  // ------------------------------------------------------------ travas de quiosque (somente tablet)
  function requestFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  if (MODE === 'tablet') {
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      // bloqueia atalhos de recarregar/abrir ferramentas quando há teclado físico
      if (e.key === 'F5' || (e.ctrlKey && ['r', 'R', 'p', 'P', 's', 'S'].includes(e.key)) || e.key === 'F12') e.preventDefault();
    });
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
  } else {
    document.body.classList.add('mode-link');
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* */ }
  }
  if (MODE === 'tablet') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  // Menu técnico oculto: 7 toques rápidos no canto superior esquerdo.
  let taps = [];
  document.getElementById('secret').addEventListener('click', () => {
    if (MODE !== 'tablet') return;
    const now = Date.now();
    taps = taps.filter((x) => now - x < 3000).concat(now);
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
    const nav = (navigator.language || 'pt').slice(0, 2);
    if (MODE === 'link' && UI[nav]) lang = nav;
    if (MODE === 'link') {
      try { await loadConfig(); } catch (e) { return render('error', h('div', { class: 'card center' }, h('p', {}, e.status === 404 ? 'Link inválido ou desativado.' : t('error')))); }
      return showWelcome();
    }
    applyBranding();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/kiosk/sw.js', { scope: '/kiosk/' }).catch(() => {});
    keepAwake();
    if (!store.get(TOKEN_KEY)) return showPairing();
    await refreshConfig();
    if (!store.get(TOKEN_KEY)) return; // foi despareado
    if (config) showWelcome(); else render('offline', h('div', { class: 'card center' }, h('h1', {}, 'Conectando…')));
  }

  // Sincronização em segundo plano (tablet): roda sempre, inclusive em um tablet recém-pareado.
  function startBackgroundSync() {
    setInterval(() => {
      if (store.get(TOKEN_KEY) && ['welcome', 'unavailable', 'offline', 'closed'].includes(screen)) refreshConfig();
    }, CONFIG_REFRESH_MS);
    setInterval(() => { if (store.get(TOKEN_KEY)) flushQueue(); }, FLUSH_MS);
    window.addEventListener('online', () => { if (store.get(TOKEN_KEY)) flushQueue(); });
  }

  if (MODE === 'tablet') startBackgroundSync();
  boot().then(() => { if (MODE === 'tablet' && store.get(TOKEN_KEY)) flushQueue(); });
})();
