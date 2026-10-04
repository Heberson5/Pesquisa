'use strict';
// Painel administrativo (SPA sem dependências). Todo texto vindo do servidor é
// inserido com textContent (via h()) — nunca innerHTML — para impedir XSS.
(() => {
  const root = document.getElementById('root');
  let me = null;
  let csrf = null;
  let questionTypes = {};
  const cache = {};

  // ------------------------------------------------------------ utilidades
  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(attrs.svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'svg' || v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const fmtDate = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const fmtNps = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toLocaleString('pt-BR'));
  const npsClass = (n) => (n === null ? '' : n >= 50 ? 'good' : n >= 0 ? 'midc' : 'bad');
  const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  let toastTimer;
  function toast(msg, error = false) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (error ? ' error' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (body !== undefined && !(body instanceof Blob)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = csrf || '';
    const res = await fetch('/api/admin' + path, { method: opts.method || 'GET', headers, body, credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401 && path !== '/login') {
      const hadSession = !!me;
      me = null; showLogin(hadSession ? 'Sua sessão expirou. Entre novamente.' : '');
      throw new Error('401');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.code === 'MFA_SETUP_REQUIRED') { showMfaSetup(true); throw new Error('401'); }
    if (!res.ok) { const e = new Error(data.error || 'Erro ' + res.status); e.status = res.status; throw e; }
    return data;
  }

  const icon = (name, size = 20, opts = {}) => window.Icons.svg(name, { size, ...opts });
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  function modal(title, content, actions = []) {
    const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } });
    const close = () => bg.remove();
    bg.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('h2', {}, title), content,
      h('div', { class: 'actions' }, h('button', { class: 'btn secondary', onclick: close }, 'Cancelar'),
        ...actions.map((a) => h('button', { class: 'btn ' + (a.cls || ''), onclick: () => a.onClick(close) }, a.label)))));
    document.body.append(bg);
    return close;
  }

  // ------------------------------------------------------------ identidade visual e tema
  let branding = { companyName: 'Pesquisa de Satisfação', primaryColor: '#0f3d5e', accentColor: '#ffd166', logoUrl: null };
  let settings = null;
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('admin.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('admin.' + k, v); } catch { /* */ } },
  };
  function applyBranding(b) {
    if (b) branding = { ...branding, ...b };
    const r = document.documentElement.style;
    r.setProperty('--brand', branding.primaryColor);
    r.setProperty('--accent', branding.accentColor);
    document.title = 'Painel · ' + branding.companyName;
  }
  function applyTheme() {
    const t = prefs.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
  }
  applyTheme();
  const loadBranding = fetch('/api/public/branding', { cache: 'no-store' }).then((r) => r.json()).then(applyBranding).catch(() => {});

  // ------------------------------------------------------------ login
  // Moldura das telas sem login (entrar, 2FA, esqueci a senha, redefinir).
  async function loginShell(title, sub, ...content) {
    await loadBranding;
    root.replaceChildren(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-hero' },
        branding.logoUrl ? h('div', {}, h('span', { class: 'logo-box' }, h('img', { src: branding.logoUrl, alt: branding.companyName })))
          : h('div', { class: 'row' }, h('span', { class: 'brand-mark' }, initials(branding.companyName)), h('b', {}, branding.companyName)),
        h('div', {}, h('h2', {}, 'A opinião dos seus clientes, de todas as filiais, em um só lugar.'),
          h('p', {}, 'NPS em tempo real, relatórios em PowerPoint e tablets em modo quiosque.'))),
      h('div', { class: 'login-side' }, h('div', { class: 'login' }, h('h1', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, ...content))));
  }

  function formOf(fields, button, onSubmit) {
    const err = h('p', { class: 'bad small', role: 'alert' });
    const btn = h('button', { class: 'btn', type: 'submit' }, button);
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try { await onSubmit(); } catch (ex) { if (ex.message !== '401') err.textContent = ex.message; btn.disabled = false; }
    } }, ...fields, btn, err);
    return { form, err };
  }

  async function afterLogin(r) {
    csrf = r.csrf;
    if (r.mfaSetupRequired) return showMfaSetup(true);
    await loadMe(); route();
  }

  async function showLogin(msg) {
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'seu@email.com' });
    const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: '••••••••••' });
    const { form, err } = formOf([h('label', { class: 'f' }, 'E-mail', email), h('label', { class: 'f' }, 'Senha', pw)], 'Entrar', async () => {
      try {
        const r = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        if (r.mfaRequired) return showMfaStep(r.challenge);
        await afterLogin(r);
      } catch (ex) { pw.value = ''; throw ex; }
    });
    err.textContent = msg || '';
    await loginShell('Entrar no painel', branding.companyName, form,
      h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showForgot(email.value); } }, 'Esqueci minha senha'));
    email.focus();
  }

  async function showMfaStep(challenge) {
    const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '11', placeholder: '000000', class: 'code-input' });
    const { form } = formOf([h('label', { class: 'f' }, 'Código de 6 dígitos', code)], 'Confirmar', async () => {
      await afterLogin(await api('/login/mfa', { method: 'POST', body: { challenge, code: code.value } }));
    });
    await loginShell('Verificação em duas etapas', 'Abra o aplicativo autenticador no celular e digite o código. Sem o celular? Use um dos códigos de recuperação.',
      form, h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showLogin(); } }, 'Voltar'));
    code.focus();
  }

  async function showForgot(prefill = '') {
    const email = h('input', { type: 'email', required: true, value: prefill, placeholder: 'seu@email.com' });
    const { form, err } = formOf([h('label', { class: 'f' }, 'E-mail cadastrado', email)], 'Enviar link', async () => {
      const r = await api('/password/forgot', { method: 'POST', body: { email: email.value } });
      err.className = 'good small'; err.textContent = r.message;
    });
    await loginShell('Esqueci minha senha', 'Enviaremos um link para criar uma nova senha. O link vale por 30 minutos.',
      form, h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); showLogin(); } }, 'Voltar ao login'));
    email.focus();
  }

  async function showReset(token) {
    const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
    const { form } = formOf([h('label', { class: 'f' }, 'Nova senha (mín. 10 caracteres, letras e números)', pw), h('label', { class: 'f' }, 'Repita a nova senha', pw2)], 'Salvar nova senha', async () => {
      if (pw.value !== pw2.value) throw new Error('As senhas não conferem.');
      await api('/password/reset', { method: 'POST', body: { token, password: pw.value } });
      history.replaceState(null, '', '/admin/'); // remove o token da barra de endereço
      showLogin('Senha alterada. Entre com a nova senha.');
    });
    await loginShell('Criar nova senha', null, form);
  }

  // Configuração do 2FA. forced = administrador que ainda não ativou (obrigatório).
  async function showMfaSetup(forced) {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const area = h('div');
    const { form } = formOf([h('label', { class: 'f' }, 'Confirme sua senha', pw)], 'Continuar', async () => {
      const s = await api('/mfa/setup', { method: 'POST', body: { password: pw.value } });
      const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000', class: 'code-input' });
      const step2 = formOf([h('label', { class: 'f' }, 'Digite o código que aparece no aplicativo', code)], 'Ativar', async () => {
        const r = await api('/mfa/enable', { method: 'POST', body: { code: code.value } });
        showRecoveryCodes(r.recoveryCodes, forced);
      });
      area.replaceChildren(
        h('ol', { class: 'small steps' }, h('li', {}, 'Instale o Google Authenticator, Microsoft Authenticator ou Authy.'),
          h('li', {}, 'Leia o QR Code abaixo com o aplicativo.'), h('li', {}, 'Digite o código de 6 dígitos gerado.')),
        h('img', { src: s.qr, alt: 'QR Code para o aplicativo autenticador', class: 'qr' }),
        h('p', { class: 'small muted' }, 'Não consegue ler? Digite esta chave: ', h('code', { class: 'secret' }, s.secret)),
        step2.form);
      code.focus();
    });
    area.append(form);
    const content = [area];
    if (forced) {
      content.push(h('a', { href: '#', class: 'small', onclick: async (e) => { e.preventDefault(); await api('/logout', { method: 'POST' }).catch(() => {}); me = null; showLogin(); } }, 'Sair'));
      await loginShell('Ative a verificação em duas etapas', 'Por segurança, administradores precisam usar um código do celular além da senha.', ...content);
    } else {
      modal('Ativar verificação em duas etapas', h('div', {}, ...content));
    }
    pw.focus();
  }

  function showRecoveryCodes(codes, forced) {
    document.querySelector('.modal-bg')?.remove();
    const text = codes.join('\n');
    const download = () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([`Códigos de recuperação — ${branding.companyName}\nCada código funciona uma única vez.\n\n${text}\n`], { type: 'text/plain' })), download: 'codigos-recuperacao.txt' });
      document.body.append(a); a.click(); a.remove();
    };
    const content = h('div', {},
      h('p', {}, 'Guarde estes códigos em local seguro. Cada um permite entrar uma única vez caso você perca o celular.'),
      h('div', { class: 'recovery' }, codes.map((c) => h('code', {}, c))),
      h('div', { class: 'row' }, h('button', { class: 'btn secondary', onclick: download }, icon('download', 16), 'Baixar .txt'),
        h('button', { class: 'btn secondary', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copiado.')) }, icon('copy', 16), 'Copiar')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { document.querySelector('.modal-bg')?.remove(); me = null; await loadMe(); route(); } }, 'Guardei os códigos, continuar')));
    if (forced) loginShell('2FA ativado', null, content);
    else modal('2FA ativado', content);
  }

  let displays = {};
  async function loadMe() {
    const r = await api('/me');
    if (r.mfaSetupRequired) { csrf = r.csrf; showMfaSetup(true); throw new Error('401'); }
    me = r.user; csrf = r.csrf; questionTypes = r.questionTypes; displays = r.displays; settings = r.settings;
    applyBranding({ companyName: settings.companyName, primaryColor: settings.primaryColor, accentColor: settings.accentColor,
      logoUrl: settings.logoMediaId ? '/media/' + settings.logoMediaId : null });
  }

  // ------------------------------------------------------------ layout + rotas
  // [rota, rótulo, página, perfil exigido, grupo]
  const PAGES = [
    ['dashboard', 'Visão geral', pageDashboard, null, 'Análise'],
    ['respostas', 'Respostas', pageResponses, null, 'Análise'],
    ['pesquisas', 'Pesquisas', pageSurveys, null, 'Coleta'],
    ['filiais', 'Filiais', pageBranches, null, 'Coleta'],
    ['dispositivos', 'Tablets', pageDevices, null, 'Coleta'],
    ['usuarios', 'Usuários', pageUsers, 'admin', 'Administração'],
    ['configuracoes', 'Configurações', pageSettings, 'admin', 'Administração'],
    ['auditoria', 'Auditoria', pageAudit, 'admin', 'Administração'],
    ['conta', 'Minha conta', pageAccount, null, 'Administração'],
  ];
  const menuIcon = (id) => settings?.menuIcons?.[id] || window.Icons.MENU_DEFAULTS[id];

  function layout(active, content) {
    const collapsed = prefs.get('sidebar', 'open') === 'collapsed';
    const shell = h('div', { class: 'layout' + (collapsed ? ' collapsed' : '') });
    const visible = PAGES.filter((p) => !p[3] || me.role === p[3]);
    const groups = [...new Set(visible.map((p) => p[4]))];
    const dark = document.documentElement.dataset.theme === 'dark';
    const toggleCollapse = () => {
      const now = !shell.classList.contains('collapsed');
      shell.classList.toggle('collapsed', now);
      prefs.set('sidebar', now ? 'collapsed' : 'open');
      collapseBtn.replaceChildren(icon(now ? 'chevrons-right' : 'chevrons-left'), h('span', {}, 'Recolher menu'));
      collapseBtn.title = now ? 'Expandir menu' : 'Recolher menu';
    };
    const collapseBtn = h('button', { class: 'side-btn collapse-btn', onclick: toggleCollapse, title: collapsed ? 'Expandir menu' : 'Recolher menu' },
      icon(collapsed ? 'chevrons-right' : 'chevrons-left'), h('span', {}, 'Recolher menu'));
    shell.append(
      h('nav', { class: 'side', 'aria-label': 'Menu principal' },
        h('div', { class: 'brand' },
          branding.logoUrl ? h('img', { class: 'brand-logo', src: branding.logoUrl, alt: branding.companyName }) : null,
          h('span', { class: 'brand-mark' + (branding.logoUrl ? ' hidden' : '') }, initials(branding.companyName)),
          branding.logoUrl ? null : h('span', { class: 'brand-name' }, branding.companyName)),
        groups.map((g) => h('div', { class: 'nav' }, h('div', { class: 'nav-label' }, g),
          visible.filter((p) => p[4] === g).map(([id, label]) => h('a', { href: '#/' + id, class: id === active ? 'active' : null, title: label,
            onclick: () => shell.classList.remove('mobile-open') }, icon(menuIcon(id)), h('span', {}, label))))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'side-foot' },
          h('button', { class: 'side-btn', title: dark ? 'Tema claro' : 'Tema escuro', onclick: () => { prefs.set('theme', dark ? 'light' : 'dark'); applyTheme(); route(); } },
            icon(dark ? 'sun' : 'moon'), h('span', {}, dark ? 'Tema claro' : 'Tema escuro')),
          collapseBtn,
          h('div', { class: 'who', title: me.name }, h('span', { class: 'avatar' }, initials(me.name)),
            h('div', { class: 'who-text' }, h('b', {}, me.name), h('span', {}, me.role === 'admin' ? 'Administrador' : 'Gestor de filial'))),
          h('button', { class: 'side-btn', title: 'Sair', onclick: async () => { await api('/logout', { method: 'POST' }).catch(() => {}); me = null; showLogin(); } },
            icon('logout'), h('span', {}, 'Sair')))),
      h('div', {},
        h('div', { class: 'mobile-bar' },
          h('button', { class: 'btn secondary icon-only', 'aria-label': 'Abrir menu', onclick: () => shell.classList.add('mobile-open') }, icon('menu')),
          h('b', {}, branding.companyName)),
        h('main', { class: 'main' }, content)));
    shell.addEventListener('click', (e) => { if (e.target === shell) shell.classList.remove('mobile-open'); });
    root.replaceChildren(shell);
  }

  async function route() {
    const reset = /^#\/redefinir\/([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
    if (reset) return showReset(reset[1]);
    if (!me) { try { await loadMe(); } catch { return; } }
    const [, name = 'dashboard', param] = location.hash.split('/');
    const page = PAGES.find((p) => p[0] === name && (!p[3] || me.role === p[3])) || PAGES[0];
    const container = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
    layout(page[0], container);
    try { container.replaceChildren(await page[2](param)); } catch (e) { if (e.message !== '401') container.replaceChildren(h('div', { class: 'card bad' }, e.message)); }
  }
  window.addEventListener('hashchange', route);

  // Cabeçalho padrão das páginas: título, subtítulo e botões.
  const pageHead = (title, sub, ...actions) => h('div', { class: 'topbar' },
    h('div', {}, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, ...actions));

  async function branches(force) { if (force || !cache.branches) cache.branches = await api('/branches'); return cache.branches; }
  async function surveys(force) { if (force || !cache.surveys) cache.surveys = await api('/surveys'); return cache.surveys; }

  // ------------------------------------------------------------ filtros reutilizáveis
  function filterBar(state, onChange, { withSurvey = true } = {}) {
    const from = h('input', { type: 'date', value: state.from });
    const to = h('input', { type: 'date', value: state.to });
    const br = h('select', {}, h('option', { value: '' }, 'Todas as filiais'), cache.branches.map((b) => h('option', { value: String(b.id) }, b.name)));
    br.value = state.branchId || '';
    const sv = h('select', {}, h('option', { value: '' }, 'Todas as pesquisas'), cache.surveys.map((s) => h('option', { value: String(s.id) }, s.title)));
    sv.value = state.surveyId || '';
    const apply = () => { Object.assign(state, { from: from.value, to: to.value, branchId: br.value, surveyId: sv.value }); onChange(); };
    [from, to, br, sv].forEach((el) => el.addEventListener('change', apply));
    return h('div', { class: 'filters card' },
      h('label', { class: 'f' }, 'De', from), h('label', { class: 'f' }, 'Até', to),
      h('label', { class: 'f' }, 'Filial', br), withSurvey ? h('label', { class: 'f' }, 'Pesquisa', sv) : null);
  }
  const qs = (state) => new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
  const filterState = { from: isoDay(new Date(Date.now() - 29 * 86400000)), to: isoDay(new Date()), branchId: '', surveyId: '' };

  // ------------------------------------------------------------ dashboard
  async function pageDashboard() {
    await Promise.all([branches(), surveys()]);
    const body = h('div');
    const load = async () => {
      body.replaceChildren(h('p', { class: 'muted' }, 'Carregando…'));
      const s = await api('/stats?' + qs(filterState));
      body.replaceChildren(renderStats(s));
    };
    await load();
    return h('div', {}, pageHead('Visão geral', 'Indicador NPS e satisfação das filiais', exportButtons()), filterBar(filterState, load), body);
  }

  function exportButtons() {
    return [
      h('button', { class: 'btn secondary', onclick: () => { location.href = '/api/admin/responses.csv?' + qs(filterState); } }, icon('download', 18), 'CSV'),
      h('button', { class: 'btn', onclick: () => { toast('Gerando PowerPoint…'); location.href = '/api/admin/report.pptx?' + qs(filterState); } }, icon('slides', 18), 'Exportar PowerPoint'),
    ];
  }

  function npsStack(o) {
    const t = o.total || 1;
    const bar = h('div', { class: 'stack', title: `Promotores ${o.promoters} · Neutros ${o.passives} · Detratores ${o.detractors}` },
      h('span', { class: 'p' }), h('span', { class: 'n' }), h('span', { class: 'd' }));
    [o.promoters, o.passives, o.detractors].forEach((v, i) => { bar.children[i].style.width = (v / t) * 100 + '%'; });
    return bar;
  }

  function renderStats(s) {
    const o = s.overall;
    const pct = (v) => (o.total ? Math.round((v / o.total) * 100) + '%' : '—');
    const kpi = (ic, cls, label, value, valueCls, hint) => h('div', { class: 'card kpi' },
      h('div', { class: 'kpi-icon ' + cls }, icon(ic, 22)),
      h('div', {}, h('div', { class: 'label' }, label), h('div', { class: 'value ' + valueCls }, value), hint ? h('div', { class: 'small muted' }, hint) : null));
    const kpis = h('div', { class: 'grid k4' },
      kpi('gauge', '', 'NPS', fmtNps(o.nps), npsClass(o.nps), o.total ? `${o.total.toLocaleString('pt-BR')} notas de NPS` : 'Sem notas de NPS'),
      kpi('inbox', '', 'Respostas', s.totalResponses.toLocaleString('pt-BR'), '', 'pesquisas concluídas'),
      kpi('thumbs', 'good', 'Promotores', pct(o.promoters), 'good', 'notas 9 e 10'),
      kpi('activity', 'bad', 'Detratores', pct(o.detractors), 'bad', 'notas de 0 a 6'));

    const maxN = Math.max(1, ...s.scoreDist.map((d) => d.n));
    const dist = h('div', { class: 'bars' }, Array.from({ length: 11 }, (_, n) => {
      const c = s.scoreDist.find((d) => d.score === n)?.n || 0;
      const col = h('div'); col.style.height = (c / maxN) * 100 + '%';
      col.style.background = n <= 6 ? 'var(--bad)' : n <= 8 ? 'var(--neutral)' : 'var(--good)';
      return h('div', { class: 'bar', title: `${c} notas ${n}` }, h('small', {}, c || ''), col, h('b', {}, n));
    }));

    const byBranch = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Filial'), h('th', {}, 'Respostas'), h('th', {}, 'NPS'), h('th', {}, 'Composição'))),
      h('tbody', {}, s.byBranch.length ? s.byBranch.map((b) => h('tr', {},
        h('td', {}, b.name), h('td', {}, b.responses), h('td', { class: npsClass(b.nps) }, h('b', {}, fmtNps(b.nps))), h('td', {}, b.total ? npsStack(b) : '—')))
        : h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'Nenhuma resposta no período.')))));

    const byQuestion = s.byQuestion.length ? s.byQuestion.map((q) => h('div', { class: 'hbar' },
      h('span', { title: q.survey }, q.text), npsStack(q), h('b', { class: npsClass(q.nps) }, fmtNps(q.nps))))
      : h('p', { class: 'muted' }, 'Nenhuma pergunta marcada para NPS recebeu respostas.');

    return h('div', {}, kpis,
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Evolução diária'), trendChart(s.trend)),
        h('div', { class: 'card' }, h('h2', {}, 'Distribuição das notas (0 a 10)'), dist)),
      h('div', { class: 'card' }, h('h2', {}, 'NPS por filial'), byBranch,
        h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'lp' }), 'Promotores'), h('span', {}, h('i', { class: 'ln' }), 'Neutros'), h('span', {}, h('i', { class: 'ld' }), 'Detratores'))),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'NPS por pergunta marcada'), byQuestion),
        h('div', { class: 'card comments-card' }, h('h2', {}, 'Comentários recentes'), s.comments.length ? s.comments.map((c) => h('div', { class: 'comment' },
          h('span', { class: 'comment-icon' }, icon('message', 16)),
          h('div', {}, h('div', {}, c.comment), h('div', { class: 'small muted' }, `${c.branch} · ${fmtDate(c.submitted_at)}`)))) : h('p', { class: 'muted' }, 'Sem comentários.'))));
  }

  function trendChart(trend) {
    if (!trend.length) return h('p', { class: 'muted' }, 'Sem dados no período.');
    const W = 600, H = 200, P = 28;
    const maxR = Math.max(1, ...trend.map((t) => t.responses));
    const x = (i) => P + (trend.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (trend.length - 1));
    const bw = Math.max(2, Math.min(24, (W - 2 * P) / trend.length - 4));
    const yN = (v) => H - P - ((v + 100) / 200) * (H - 2 * P);
    const svg = h('svg', { svg: true, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Evolução de respostas e NPS' });
    svg.append(h('line', { svg: true, x1: P, x2: W - P, y1: yN(0), y2: yN(0), class: 'zero', 'stroke-dasharray': '4 4' }));
    trend.forEach((t, i) => {
      const bh = (t.responses / maxR) * (H - 2 * P) * 0.6;
      svg.append(h('rect', { svg: true, x: x(i) - bw / 2, y: H - P - bh, width: bw, height: bh, class: 'tbar', rx: 3 },
        h('title', { svg: true }, `${t.day}: ${t.responses} respostas, NPS ${fmtNps(t.nps)}`)));
    });
    const pts = trend.map((t, i) => (t.nps === null ? null : `${x(i)},${yN(t.nps)}`)).filter(Boolean);
    if (pts.length) svg.append(h('polyline', { svg: true, points: pts.join(' '), class: 'tline' }));
    trend.forEach((t, i) => { if (t.nps !== null) svg.append(h('circle', { svg: true, cx: x(i), cy: yN(t.nps), r: 3.5, class: 'tpt' })); });
    svg.append(h('text', { svg: true, x: 2, y: yN(100) + 4, 'font-size': 11, class: 'tlabel' }, '+100'));
    svg.append(h('text', { svg: true, x: 2, y: yN(-100) + 4, 'font-size': 11, class: 'tlabel' }, '-100'));
    return h('div', { class: 'chart' }, svg, h('div', { class: 'legend' }, h('span', {}, '▮ Respostas por dia'), h('span', {}, '— NPS do dia')));
  }

  // ------------------------------------------------------------ respostas
  async function pageResponses() {
    await Promise.all([branches(), surveys()]);
    let page = 1;
    const body = h('div');
    const load = async () => {
      const r = await api(`/responses?${qs(filterState)}&page=${page}`);
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      body.replaceChildren(h('div', { class: 'card' },
        h('p', { class: 'muted' }, `${r.total} respostas encontradas`),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Filial'), h('th', {}, 'Pesquisa'), h('th', {}, 'Respostas'))),
          h('tbody', {}, r.rows.length ? r.rows.map((x) => h('tr', {},
            h('td', {}, fmtDate(x.submitted_at), h('div', { class: 'small muted' }, x.device || '')),
            h('td', {}, x.branch), h('td', {}, x.survey),
            h('td', {}, h('ul', { class: 'answers' }, (x.answers || []).map((a) => h('li', {},
              h('b', {}, a.question + ': '), a.value, a.is_nps ? h('span', { class: 'badge nps' }, ' NPS') : null))))))
            : h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'Nenhuma resposta.'))))),
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary sm', disabled: page <= 1, onclick: () => { page--; load(); } }, '‹ Anterior'),
          h('span', { class: 'small muted' }, `Página ${page} de ${pages}`),
          h('button', { class: 'btn secondary sm', disabled: page >= pages, onclick: () => { page++; load(); } }, 'Próxima ›'))));
    };
    await load();
    return h('div', {},
      pageHead('Respostas', 'Todas as pesquisas recebidas dos tablets', exportButtons()),
      filterBar(filterState, () => { page = 1; load(); }), body);
  }

  // ------------------------------------------------------------ pesquisas
  async function pageSurveys(param) {
    if (param) return surveyEditor(param === 'nova' ? null : Number(param));
    const list = await surveys(true);
    return h('div', {},
      pageHead('Pesquisas', 'Perguntas exibidas nos tablets e marcação do NPS',
        me.role === 'admin' ? h('a', { class: 'btn', href: '#/pesquisas/nova' }, icon('plus', 18), 'Nova pesquisa') : null),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Título'), h('th', {}, 'Perguntas'), h('th', {}, 'NPS'), h('th', {}, 'Respostas'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, list.length ? list.map((s) => h('tr', {},
          h('td', {}, h('b', {}, s.title), h('div', { class: 'small muted' }, 'Atualizada ' + fmtDate(s.updated_at))),
          h('td', {}, s.questions), h('td', {}, s.nps_questions ? h('span', { class: 'badge nps' }, `${s.nps_questions} marcada(s)`) : h('span', { class: 'badge warn' }, 'nenhuma')),
          h('td', {}, s.responses), h('td', {}, h('span', { class: 'badge ' + (s.active ? 'ok' : 'off') }, s.active ? 'Ativa' : 'Inativa')),
          h('td', {}, h('div', { class: 'row' },
            h('a', { class: 'btn secondary sm', href: '#/pesquisas/' + s.id }, me.role === 'admin' ? 'Editar' : 'Ver'),
            me.role === 'admin' ? h('button', { class: 'btn secondary sm', onclick: async () => {
              const r = await api(`/surveys/${s.id}/duplicate`, { method: 'POST' }); toast('Pesquisa duplicada.'); location.hash = '#/pesquisas/' + r.id;
            } }, 'Duplicar') : null))))
          : h('tr', {}, h('td', { colspan: '6', class: 'empty' }, 'Nenhuma pesquisa criada.'))))));
  }

  const NEW_SURVEY = {
    title: '', welcome_title: 'Sua opinião é muito importante!', welcome_text: 'Leva menos de 1 minuto.',
    thanks_title: 'Obrigado!', thanks_text: 'Sua resposta nos ajuda a melhorar.', thanks_seconds: 8, idle_seconds: 45, active: 1,
    thanks_media_id: null, thanks_media: null, has_responses: false,
    questions: [{ text: 'Em uma escala de 0 a 10, o quanto você recomendaria nossa empresa a um amigo ou familiar?', type: 'nps', required: true, is_nps: true, options: [] }],
  };

  function defaultStyleName() {
    const d = settings?.defaultDisplay || 'numbers';
    return d === 'numbers' ? 'números coloridos' : d === 'faces' ? 'carinhas coloridas' : (window.Icons.ICONS[settings.ratingIcon]?.label || 'ícones').toLowerCase();
  }

  async function surveyEditor(sid) {
    const s = sid ? await api('/surveys/' + sid) : structuredClone(NEW_SURVEY);
    const ro = me.role !== 'admin';
    const locked = s.has_responses;
    const f = {};
    const field = (key, label, type = 'text', extra = {}) => {
      const el = type === 'textarea' ? h('textarea', { rows: '2', ...extra }) : h('input', { type, ...extra });
      el.value = s[key] ?? ''; el.disabled = ro; f[key] = el;
      return h('label', { class: 'f' }, label, el);
    };
    const qList = h('div');
    const questions = s.questions.map((q) => ({ ...q, options: [...(q.options || [])] }));

    function renderQuestions() {
      qList.replaceChildren(...questions.map((q, i) => {
        const text = h('input', { value: q.text, placeholder: 'Texto da pergunta', disabled: ro, oninput: (e) => { q.text = e.target.value; } });
        const help = h('input', { value: q.help_text || '', placeholder: 'Texto de apoio (opcional)', disabled: ro, oninput: (e) => { q.help_text = e.target.value; } });
        const type = h('select', { disabled: ro || locked, onchange: (e) => { q.type = e.target.value; if (q.type !== 'nps') q.is_nps = false; if (['single', 'multi'].includes(q.type) && q.options.length < 2) q.options = ['Opção 1', 'Opção 2']; renderQuestions(); } },
          Object.entries(questionTypes).map(([k, v]) => h('option', { value: k }, v)));
        type.value = q.type;
        const req = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: q.required, disabled: ro, onchange: (e) => { q.required = e.target.checked; } }), 'Obrigatória');
        const isScale = ['nps', 'scale5'].includes(q.type);
        const disp = h('select', { disabled: ro, title: 'Como a escala aparece no tablet — o valor gravado é sempre o número',
          onchange: (e) => { q.display = e.target.value; renderQuestions(); } },
          Object.entries(displays).map(([k, v]) => h('option', { value: k }, 'Aparência: ' + (k === 'default' ? `${v} (${defaultStyleName()})` : v))));
        disp.value = q.display || 'default';
        const iconPick = isScale && q.display === 'icons' ? h('div', { class: 'icon-grid' },
          h('button', { class: 'icon-choice' + (!q.icon ? ' selected' : ''), title: 'Padrão das configurações', disabled: ro, onclick: () => { q.icon = null; renderQuestions(); } }, h('span', { class: 'small' }, 'Padrão')),
          window.Icons.RATING_ICONS.map((k) => h('button', { class: 'icon-choice' + (q.icon === k ? ' selected' : ''), title: window.Icons.ICONS[k].label, disabled: ro,
            onclick: () => { q.icon = k; renderQuestions(); } }, icon(k, 20, { fill: q.icon === k })))) : null;
        const nps = h('label', { class: 'chk', title: 'Somente perguntas do tipo NPS (0 a 10) entram no cálculo' },
          h('input', { type: 'checkbox', checked: q.is_nps, disabled: ro || q.type !== 'nps', onchange: (e) => { q.is_nps = e.target.checked; renderQuestions(); } }), icon('star', 16, { fill: q.is_nps }), 'Entra na análise de NPS');
        const move = (d) => { const j = i + d; if (j < 0 || j >= questions.length) return; [questions[i], questions[j]] = [questions[j], questions[i]]; renderQuestions(); };
        const opts = ['single', 'multi'].includes(q.type) ? h('div', {},
          h('div', { class: 'small muted' }, 'Opções (uma por linha)'),
          h('textarea', { rows: String(Math.max(2, q.options.length)), disabled: ro || locked, value: q.options.join('\n'),
            oninput: (e) => { q.options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); } })) : null;
        return h('div', { class: 'q-editor' + (q.is_nps ? ' nps-marked' : '') },
          h('div', { class: 'row' }, h('b', { class: 'q-num' }, String(i + 1)), text,
            ro ? null : h('button', { class: 'btn secondary sm', disabled: locked, onclick: () => move(-1), title: 'Subir' }, '↑'),
            ro ? null : h('button', { class: 'btn secondary sm', disabled: locked, onclick: () => move(1), title: 'Descer' }, '↓'),
            ro ? null : h('button', { class: 'btn danger sm', disabled: locked || questions.length === 1, onclick: () => { questions.splice(i, 1); renderQuestions(); } }, 'Remover')),
          h('div', { class: 'row', style: null }, help),
          h('div', { class: 'row' }, type, isScale ? disp : null, req, nps), iconPick ? h('div', { class: 'row' }, iconPick) : null, opts);
      }));
    }
    renderQuestions();

    // mídia de agradecimento
    let mediaId = s.thanks_media_id;
    const mediaPreview = h('div');
    const showMedia = (m) => {
      mediaPreview.replaceChildren();
      if (!m) return mediaPreview.append(h('span', { class: 'small muted' }, 'Nenhuma imagem ou vídeo.'));
      mediaPreview.append(m.mime.startsWith('video/')
        ? h('video', { class: 'preview-media', src: '/media/' + m.id, muted: true, autoplay: true, loop: true, playsinline: true })
        : h('img', { class: 'preview-media', src: '/media/' + m.id, alt: '' }));
      if (!ro) mediaPreview.append(h('button', { class: 'btn secondary sm', onclick: () => { mediaId = null; showMedia(null); } }, 'Remover mídia'));
    };
    showMedia(s.thanks_media);
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm', disabled: ro, onchange: async (e) => {
      const fl = e.target.files[0]; if (!fl) return;
      try {
        const r = await uploadMedia(fl);
        mediaId = r.id; showMedia({ id: r.id, mime: r.mime }); toast('Mídia enviada.');
      } catch (ex) { toast(ex.message, true); }
      e.target.value = '';
    } });

    const activeChk = h('input', { type: 'checkbox', checked: !!s.active, disabled: ro });
    const save = async () => {
      const body = {
        title: f.title.value, welcome_title: f.welcome_title.value, welcome_text: f.welcome_text.value,
        thanks_title: f.thanks_title.value, thanks_text: f.thanks_text.value, thanks_media_id: mediaId,
        thanks_seconds: Number(f.thanks_seconds.value), idle_seconds: Number(f.idle_seconds.value), active: activeChk.checked,
        questions: questions.map((q) => ({ text: q.text, help_text: q.help_text || '', type: q.type, required: !!q.required, is_nps: !!q.is_nps, options: q.options,
          display: ['nps', 'scale5'].includes(q.type) ? (q.display || 'default') : undefined, icon: q.display === 'icons' ? q.icon || null : null })),
      };
      try {
        if (sid) await api('/surveys/' + sid, { method: 'PUT', body });
        else { const r = await api('/surveys', { method: 'POST', body }); location.hash = '#/pesquisas/' + r.id; }
        toast('Pesquisa salva.'); cache.surveys = null;
      } catch (ex) { toast(ex.message, true); }
    };

    return h('div', {},
      pageHead(sid ? 'Editar pesquisa' : 'Nova pesquisa', s.title || null,
        h('a', { class: 'btn secondary', href: '#/pesquisas' }, 'Voltar'), ro ? null : h('button', { class: 'btn', onclick: save }, 'Salvar pesquisa')),
      locked ? h('div', { class: 'card small' }, '🔒 Esta pesquisa já possui respostas: é possível corrigir textos e a marcação de NPS, mas não adicionar/remover perguntas ou mudar tipos. Para mudanças estruturais, use "Duplicar".') : null,
      h('div', { class: 'card' }, h('h2', {}, 'Dados gerais'), h('div', { class: 'form-grid' },
        field('title', 'Título interno', 'text', { maxlength: '120' }),
        h('label', { class: 'chk' }, activeChk, 'Pesquisa ativa'))),
      h('div', { class: 'card' }, h('h2', {}, 'Tela inicial do tablet'), h('div', { class: 'form-grid' },
        field('welcome_title', 'Título', 'text', { maxlength: '120' }), field('welcome_text', 'Subtítulo', 'textarea', { maxlength: '300' }),
        field('idle_seconds', 'Voltar ao início após inatividade (segundos)', 'number', { min: '15', max: '600' }))),
      h('div', { class: 'card' }, h('h2', {}, 'Perguntas'),
        h('p', { class: 'small muted' }, 'Marque "Entra na análise de NPS" nas perguntas de 0 a 10. A aparência (números, carinhas ou ícones) não muda o cálculo: o tablet sempre grava a nota de 0 a 10.'),
        qList,
        ro || locked ? null : h('button', { class: 'btn secondary', onclick: () => { questions.push({ text: '', type: 'scale5', required: true, is_nps: false, options: [] }); renderQuestions(); } }, '+ Adicionar pergunta')),
      h('div', { class: 'card' }, h('h2', {}, 'Tela de agradecimento'), h('div', { class: 'form-grid' },
        field('thanks_title', 'Título', 'text', { maxlength: '120' }), field('thanks_text', 'Mensagem', 'textarea', { maxlength: '300' }),
        field('thanks_seconds', 'Tempo na tela (segundos)', 'number', { min: '3', max: '60' }),
        h('label', { class: 'f' }, 'Imagem ou vídeo curto (até 25 MB)', file, mediaPreview))));
  }

  // ------------------------------------------------------------ filiais
  async function pageBranches() {
    const [list, svs] = await Promise.all([branches(true), surveys(true)]);
    const isAdmin = me.role === 'admin';
    const edit = (b = {}) => {
      const code = h('input', { value: b.code || '', maxlength: '20', placeholder: 'Ex.: SP01' });
      const name = h('input', { value: b.name || '', maxlength: '100' });
      const city = h('input', { value: b.city || '', maxlength: '100' });
      const active = h('input', { type: 'checkbox', checked: b.id ? !!b.active : true });
      modal(b.id ? 'Editar filial' : 'Nova filial', h('div', { class: 'form-grid' },
        h('label', { class: 'f' }, 'Código', code), h('label', { class: 'f' }, 'Nome', name), h('label', { class: 'f' }, 'Cidade', city),
        h('label', { class: 'chk' }, active, 'Ativa')), [{ label: 'Salvar', onClick: async (close) => {
        try {
          const body = { code: code.value, name: name.value, city: city.value, active: active.checked };
          await api(b.id ? '/branches/' + b.id : '/branches', { method: b.id ? 'PUT' : 'POST', body });
          close(); toast('Filial salva.'); route();
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    return h('div', {},
      pageHead('Filiais', 'Cada filial coleta separadamente e exibe sua própria pesquisa', isAdmin ? h('button', { class: 'btn', onclick: () => edit() }, icon('plus', 18), 'Nova filial') : null),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Código'), h('th', {}, 'Filial'), h('th', {}, 'Pesquisa exibida nos tablets'), h('th', {}, 'Tablets'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, list.length ? list.map((b) => {
          const sel = h('select', { onchange: async (e) => {
            try { await api(`/branches/${b.id}/survey`, { method: 'PUT', body: { surveyId: e.target.value ? Number(e.target.value) : null } }); toast('Pesquisa da filial atualizada. Os tablets recebem em até 1 minuto.'); cache.branches = null; } catch (ex) { toast(ex.message, true); }
          } }, h('option', { value: '' }, '— nenhuma —'), svs.filter((s) => s.active).map((s) => h('option', { value: String(s.id) }, s.title)));
          sel.value = b.survey_id ? String(b.survey_id) : '';
          return h('tr', {}, h('td', {}, h('code', {}, b.code)), h('td', {}, h('b', {}, b.name), h('div', { class: 'small muted' }, b.city || '')),
            h('td', {}, sel), h('td', {}, b.devices), h('td', {}, h('span', { class: 'badge ' + (b.active ? 'ok' : 'off') }, b.active ? 'Ativa' : 'Inativa')),
            h('td', {}, isAdmin ? h('button', { class: 'btn secondary sm', onclick: () => edit(b) }, 'Editar') : null));
        }) : h('tr', {}, h('td', { colspan: '6', class: 'empty' }, 'Nenhuma filial cadastrada.'))))));
  }

  // ------------------------------------------------------------ dispositivos
  function showCode(r, deviceName) {
    modal('Código de pareamento', h('div', {},
      h('p', {}, `Abra no tablet "${deviceName}" o endereço:`), h('p', {}, h('code', {}, location.origin + '/kiosk/')),
      h('p', {}, 'e digite o código abaixo:'), h('div', { class: 'code-box' }, r.code),
      h('p', { class: 'small muted' }, `Válido até ${fmtDate(r.expiresAt)} (15 minutos) e pode ser usado uma única vez. O código não será exibido novamente.`)));
  }

  async function pageDevices() {
    const [devs, brs] = await Promise.all([api('/devices'), branches(true)]);
    const now = Date.now();
    const status = (d) => {
      if (!d.active) return h('span', { class: 'badge off' }, 'Revogado');
      if (!d.paired) return h('span', { class: 'badge warn' }, d.pairing_pending ? 'Aguardando pareamento' : 'Código expirado');
      if (d.last_seen_at && now - d.last_seen_at < 3 * 60_000) return h('span', { class: 'badge ok' }, 'Online');
      return h('span', { class: 'badge' }, 'Offline');
    };
    const add = () => {
      const br = h('select', {}, brs.filter((b) => b.active).map((b) => h('option', { value: String(b.id) }, b.name)));
      const name = h('input', { placeholder: 'Ex.: Tablet recepção', maxlength: '60' });
      modal('Novo tablet', h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Filial', br), h('label', { class: 'f' }, 'Identificação', name)),
        [{ label: 'Gerar código', onClick: async (close) => {
          try { const r = await api('/devices', { method: 'POST', body: { branchId: Number(br.value), name: name.value } }); close(); showCode(r, name.value); route(); } catch (ex) { toast(ex.message, true); }
        } }]);
    };
    return h('div', {},
      pageHead('Tablets', 'Dispositivos de coleta vinculados às filiais', brs.length ? h('button', { class: 'btn', onclick: add }, icon('plus', 18), 'Novo tablet') : null),
      h('p', { class: 'muted' }, 'Cada tablet é vinculado a uma única filial. As respostas coletadas nele são sempre gravadas nessa filial — o tablet não consegue escolher ou trocar de filial.'),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Tablet'), h('th', {}, 'Filial'), h('th', {}, 'Status'), h('th', {}, 'Último contato'), h('th', {}))),
        h('tbody', {}, devs.length ? devs.map((d) => h('tr', {},
          h('td', {}, h('b', {}, d.name)), h('td', {}, d.branch_name), h('td', {}, status(d)), h('td', {}, fmtDate(d.last_seen_at)),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'btn secondary sm', onclick: async () => {
              if (d.paired && !confirm('Gerar novo código desconecta o tablet atual até ele ser pareado de novo. Continuar?')) return;
              try { const r = await api(`/devices/${d.id}/pairing-code`, { method: 'POST' }); showCode(r, d.name); route(); } catch (ex) { toast(ex.message, true); }
            } }, 'Novo código'),
            d.active ? h('button', { class: 'btn danger sm', onclick: async () => {
              if (!confirm(`Revogar o acesso do tablet "${d.name}"? Ele deixará de coletar respostas imediatamente.`)) return;
              try { await api(`/devices/${d.id}/revoke`, { method: 'POST' }); toast('Tablet revogado.'); route(); } catch (ex) { toast(ex.message, true); }
            } }, 'Revogar') : null))))
          : h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Nenhum tablet cadastrado.'))))));
  }

  // ------------------------------------------------------------ usuários
  async function pageUsers() {
    const [users, brs] = await Promise.all([api('/users'), branches(true)]);
    const edit = (u = {}) => {
      const name = h('input', { value: u.name || '', maxlength: '100' });
      const email = h('input', { type: 'email', value: u.email || '', maxlength: '254' });
      const role = h('select', {}, h('option', { value: 'gestor' }, 'Gestor de filial'), h('option', { value: 'admin' }, 'Administrador'));
      role.value = u.role || 'gestor';
      const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: u.id ? 'Deixe em branco para manter' : 'Mín. 10 caracteres, letras e números' });
      const active = h('input', { type: 'checkbox', checked: u.id ? !!u.active : true });
      const resetMfa = h('input', { type: 'checkbox' });
      const chosen = new Set(u.branches || []);
      const brBox = h('div', {}, brs.map((b) => h('label', { class: 'chk' },
        h('input', { type: 'checkbox', checked: chosen.has(b.id), onchange: (e) => { e.target.checked ? chosen.add(b.id) : chosen.delete(b.id); } }), b.name)));
      modal(u.id ? 'Editar usuário' : 'Novo usuário', h('div', { class: 'form-grid' },
        h('label', { class: 'f' }, 'Nome', name), h('label', { class: 'f' }, 'E-mail', email), h('label', { class: 'f' }, 'Perfil', role),
        h('label', { class: 'f' }, 'Senha', pw), h('label', { class: 'chk' }, active, 'Ativo'),
        u.id && u.totp_enabled && u.id !== me.id ? h('label', { class: 'chk', title: 'Use quando a pessoa perdeu o celular' }, resetMfa, 'Resetar 2FA (perdeu o celular)') : null,
        h('div', {}, h('div', { class: 'small muted' }, 'Filiais que o gestor pode ver'), brBox)),
      [{ label: 'Salvar', onClick: async (close) => {
        try {
          await api(u.id ? '/users/' + u.id : '/users', { method: u.id ? 'PUT' : 'POST', body: {
            name: name.value, email: email.value, role: role.value, password: pw.value || null, active: active.checked, branches: [...chosen], unlock: true, resetMfa: resetMfa.checked } });
          close(); toast('Usuário salvo.'); route();
        } catch (ex) { toast(ex.message, true); }
      } }]);
    };
    const bName = (id) => brs.find((b) => b.id === id)?.name || id;
    return h('div', {},
      pageHead('Usuários', 'Administradores e gestores de filial', h('button', { class: 'btn', onclick: () => edit() }, icon('plus', 18), 'Novo usuário')),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Nome'), h('th', {}, 'Perfil'), h('th', {}, 'Filiais'), h('th', {}, 'Status'), h('th', {}))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', {}, h('b', {}, u.name), h('div', { class: 'small muted' }, u.email)),
          h('td', {}, u.role === 'admin' ? 'Administrador' : 'Gestor'),
          h('td', { class: 'small' }, u.role === 'admin' ? 'Todas' : (u.branches.map(bName).join(', ') || '—')),
          h('td', {}, h('span', { class: 'badge ' + (u.active ? 'ok' : 'off') }, u.active ? 'Ativo' : 'Inativo'),
            u.locked_until && u.locked_until > Date.now() ? h('span', { class: 'badge warn' }, 'Bloqueado') : null,
            u.totp_enabled ? h('span', { class: 'badge ok', title: 'Verificação em duas etapas ativa' }, icon('shield', 12), '2FA') : null),
          h('td', {}, h('button', { class: 'btn secondary sm', onclick: () => edit(u) }, 'Editar'))))))));
  }

  // ------------------------------------------------------------ configurações
  async function uploadMedia(file, { imagesOnly = false } = {}) {
    if (file.size > 25 * 1024 * 1024) throw new Error('Arquivo maior que 25 MB.');
    if (imagesOnly && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Use uma imagem PNG, JPG, WEBP ou GIF.');
    return api('/media', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
  }

  let settingsTab = 'identidade';
  async function pageSettings() {
    const st = structuredClone(await api('/settings'));
    const body = h('div');
    const save = async () => {
      try {
        const saved = await api('/settings', { method: 'PUT', body: st });
        settings = saved;
        applyBranding({ companyName: saved.companyName, primaryColor: saved.primaryColor, accentColor: saved.accentColor,
          logoUrl: saved.logoMediaId ? '/media/' + saved.logoMediaId : null });
        toast('Configurações salvas. Os tablets recebem as mudanças em até 1 minuto.');
        route();
      } catch (ex) { toast(ex.message, true); }
    };
    const tabs = [['identidade', 'Identidade visual', 'palette'], ['menu', 'Ícones do menu', 'layout'], ['respostas', 'Ícones das respostas', 'star']];
    const renderTab = () => {
      body.replaceChildren(h('div', { class: 'tabs' }, tabs.map(([k, label, ic]) => h('button', { class: settingsTab === k ? 'active' : '',
        onclick: () => { settingsTab = k; renderTab(); } }, icon(ic, 16), label))),
      settingsTab === 'identidade' ? identityTab(st, renderTab) : settingsTab === 'menu' ? menuTab(st, renderTab) : ratingTab(st, renderTab));
    };
    renderTab();
    return h('div', {}, pageHead('Configurações', 'Logo, cores e ícones do painel e dos tablets', h('button', { class: 'btn', onclick: save }, 'Salvar configurações')), body);
  }

  function identityTab(st, rerender) {
    const name = h('input', { value: st.companyName, maxlength: '60', oninput: (e) => { st.companyName = e.target.value; } });
    const color = (key, label) => {
      const text = h('input', { value: st[key], maxlength: '7', class: 'small', oninput: (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) { st[key] = e.target.value; picker.value = e.target.value; } } });
      const picker = h('input', { type: 'color', value: st[key], oninput: (e) => { st[key] = e.target.value; text.value = e.target.value; preview(); } });
      return h('label', { class: 'f' }, label, h('div', { class: 'row' }, picker, text));
    };
    const slot = (key, title, hint) => {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden', onchange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const r = await uploadMedia(f, { imagesOnly: true }); st[key] = r.id; toast('Imagem enviada — clique em "Salvar configurações".'); rerender(); } catch (ex) { toast(ex.message, true); }
      } });
      return h('div', { class: 'brand-slot' },
        h('div', { class: 'thumb' }, st[key] ? h('img', { src: '/media/' + st[key], alt: '' }) : icon('image', 26)),
        h('div', { style: null }, h('b', {}, title), h('div', { class: 'small muted' }, hint),
          h('div', { class: 'row' }, file,
            h('button', { class: 'btn secondary sm', onclick: () => file.click() }, st[key] ? 'Trocar' : 'Enviar imagem'),
            st[key] ? h('button', { class: 'btn secondary sm', onclick: () => { st[key] = null; rerender(); } }, 'Remover') : null)));
    };
    const pv = h('div', { class: 'style-preview' });
    function preview() {
      pv.style.background = st.primaryColor;
      pv.replaceChildren(h('b', {}, 'Prévia do tablet:'), ...[1, 2, 3, 4, 5].map((n) => { const e = icon('star', 26, { fill: n <= 4 }); e.style.color = st.accentColor; return e; }));
    }
    preview();
    return h('div', { class: 'grid c2' },
      h('div', { class: 'card' }, h('h2', {}, 'Empresa e cores'),
        h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Nome da empresa', name), color('primaryColor', 'Cor principal'), color('accentColor', 'Cor de destaque')),
        h('div', { style: null }, h('p', { class: 'small muted' }, 'A cor principal é o fundo do tablet e a cor do menu; a de destaque realça botões e seleções.'), pv)),
      h('div', { class: 'card' }, h('h2', {}, 'Logo e ícones'),
        h('div', { class: 'grid' },
          slot('logoMediaId', 'Logo da empresa', 'Aparece no painel, na tela inicial do tablet e no PowerPoint. PNG com fundo transparente fica melhor.'),
          slot('faviconMediaId', 'Ícone do navegador (favicon)', 'Ícone da aba do navegador. PNG quadrado, 64×64 px ou maior.'),
          slot('appIconMediaId', 'Ícone do aplicativo', 'Ícone do app instalado no tablet. PNG quadrado de 512×512 px.'))));
  }

  function menuTab(st, rerender) {
    return h('div', { class: 'card' }, h('h2', {}, 'Ícone de cada item do menu'),
      h('p', { class: 'small muted' }, 'Clique no ícone desejado para cada item. A mudança vale para todos os usuários.'),
      PAGES.map(([id, label]) => h('div', { class: 'menu-icon-row' },
        h('div', { class: 'current' }, icon(st.menuIcons[id], 22), label),
        h('div', { class: 'icon-grid' }, window.Icons.MENU_ICONS.map((k) => h('button', {
          class: 'icon-choice' + (st.menuIcons[id] === k ? ' selected' : ''), title: window.Icons.ICONS[k].label,
          onclick: () => { st.menuIcons[id] = k; rerender(); } }, icon(k, 20)))))));
  }

  // Prévia em miniatura de uma escala 0–10 no estilo escolhido (mesmo desenho do tablet).
  function scalePreview(st, display, iconName, scheme = st.colorScheme) {
    const box = h('div', { class: 'mini-scale' });
    box.style.background = st.primaryColor;
    for (let n = 0; n <= 10; n++) {
      const c = window.Icons.levelColor(n, true, scheme);
      if (display === 'numbers') { const e = h('span', { class: 'mini-num' }, String(n)); e.style.background = c; box.append(e); }
      else if (display === 'faces') box.append(window.Icons.face(window.Icons.levelT(n, true), { color: c, mono: st.faceStyle === 'mono', size: 20 }));
      else { const on = n > 0 && n <= 8; const e = icon(iconName, 18, { fill: on }); e.style.color = on ? st.accentColor : 'rgba(255,255,255,.5)'; box.append(e); }
    }
    return box;
  }

  function ratingTab(st, rerender) {
    const isSel = (display, ic) => st.defaultDisplay === display && (display !== 'icons' || st.ratingIcon === ic);
    const card = (title, sub, display, ic) => h('button', { class: 'style-card' + (isSel(display, ic) ? ' selected' : ''),
      onclick: () => { st.defaultDisplay = display; if (ic) st.ratingIcon = ic; rerender(); } },
      scalePreview(st, display, ic), h('b', {}, title), h('span', { class: 'small muted' }, sub));
    const scheme = (v, title, sub) => h('button', { class: 'style-card' + (st.colorScheme === v ? ' selected' : ''), onclick: () => { st.colorScheme = v; rerender(); } },
      scalePreview(st, 'numbers', null, v), h('b', {}, title), h('span', { class: 'small muted' }, sub));
    const faceOpt = (v, label) => h('button', { class: 'style-card' + (st.faceStyle === v ? ' selected' : ''), onclick: () => { st.faceStyle = v; rerender(); } },
      scalePreview({ ...st, faceStyle: v }, 'faces'), h('b', {}, label));
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'Estilo padrão das respostas'),
        h('p', { class: 'small muted' }, 'Usado nas perguntas de escala com aparência "Padrão das configurações" (o padrão de toda pergunta nova). Qualquer estilo vale para o NPS: o tablet sempre grava a nota de 0 a 10.'),
        h('div', { class: 'style-grid' },
          card('Números coloridos', 'Cores conforme o nível de satisfação', 'numbers'),
          card('Carinhas coloridas', 'Expressão e cor mudam com a nota', 'faces'),
          window.Icons.RATING_ICONS.map((k) => card(window.Icons.ICONS[k].label, 'Preenche até a nota escolhida', 'icons', k)))),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Cores conforme o nível de satisfação'),
          h('p', { class: 'small muted' }, 'Vale para números e carinhas.'),
          h('div', { class: 'style-grid two' },
            scheme('bands', 'Faixas do NPS', 'Vermelho 0–6 · amarelo 7–8 · verde 9–10'),
            scheme('gradient', 'Gradiente', 'Muda aos poucos do vermelho ao verde'))),
        h('div', { class: 'card' }, h('h2', {}, 'Estilo das carinhas'),
          h('div', { class: 'style-grid two' }, faceOpt('color', 'Coloridas'), faceOpt('mono', 'Só contorno')))));
  }

  // ------------------------------------------------------------ auditoria
  async function pageAudit() {
    const rows = await api('/audit');
    return h('div', {}, pageHead('Auditoria', 'Últimas 200 ações registradas'),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Quando'), h('th', {}, 'Usuário'), h('th', {}, 'Ação'), h('th', {}, 'Detalhes'), h('th', {}, 'IP'))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.at)), h('td', {}, r.email || '—'), h('td', {}, h('code', {}, r.action)),
          h('td', { class: 'small muted' }, r.detail || ''), h('td', { class: 'small' }, r.ip || '')))))));
  }

  // ------------------------------------------------------------ minha conta
  async function pageAccount() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const pw = h('input', { type: 'password', autocomplete: 'new-password' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const mfa = await api('/mfa');
    const askPw = (title, withCode, run) => {
      const p = h('input', { type: 'password', autocomplete: 'current-password' });
      const c = h('input', { inputmode: 'numeric', maxlength: '6', placeholder: '000000' });
      modal(title, h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Senha atual', p), withCode ? h('label', { class: 'f' }, 'Código do aplicativo', c) : null),
        [{ label: 'Confirmar', onClick: async (close) => { try { await run(p.value, c.value, close); } catch (ex) { toast(ex.message, true); } } }]);
    };
    const notif = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: me.notify[key], onchange: async (e) => {
      try { await api('/me/notifications', { method: 'PUT', body: { [key]: e.target.checked } }); me.notify[key] = e.target.checked; toast('Preferência salva.'); } catch (ex) { toast(ex.message, true); }
    } }), label);
    return h('div', {}, pageHead('Minha conta', me.email),
      h('div', { class: 'grid c2' },
        h('div', { class: 'card' }, h('h2', {}, 'Verificação em duas etapas (2FA)'),
          h('p', {}, mfa.enabled ? h('span', { class: 'badge ok' }, icon('shield', 14), 'Ativa') : h('span', { class: 'badge warn' }, 'Desativada'),
            mfa.enabled ? h('span', { class: 'small muted' }, `  ${mfa.recoveryCodesLeft} códigos de recuperação restantes`) : null),
          h('p', { class: 'small muted' }, 'Além da senha, o login pede um código que muda a cada 30 segundos no seu celular.'),
          h('div', { class: 'row' },
            !mfa.enabled ? h('button', { class: 'btn', onclick: () => showMfaSetup(false) }, 'Ativar 2FA') : null,
            mfa.enabled ? h('button', { class: 'btn secondary', onclick: () => askPw('Gerar novos códigos de recuperação', false, async (p, _c, close) => {
              const r = await api('/mfa/recovery-codes', { method: 'POST', body: { password: p } }); close(); showRecoveryCodes(r.recoveryCodes, false);
            }) }, 'Novos códigos de recuperação') : null,
            mfa.enabled && !mfa.required ? h('button', { class: 'btn danger', onclick: () => askPw('Desativar 2FA', true, async (p, c, close) => {
              await api('/mfa/disable', { method: 'POST', body: { password: p, code: c } }); close(); toast('2FA desativado.'); route();
            }) }, 'Desativar') : null),
          mfa.required ? h('p', { class: 'small muted' }, 'Obrigatório para administradores nesta empresa.') : null),
        h('div', { class: 'card' }, h('h2', {}, 'Notificações por e-mail'),
          h('div', { class: 'grid' },
            notif('detractors', 'Cliente insatisfeito (nota de 0 a 6) nas minhas filiais'),
            notif('reports', 'Relatório semanal em PowerPoint'),
            notif('offline', 'Tablet sem sinal nas minhas filiais')))),
      h('div', { class: 'card' }, h('h2', {}, 'Trocar senha'), h('div', { class: 'form-grid' },
        h('label', { class: 'f' }, 'Senha atual', cur), h('label', { class: 'f' }, 'Nova senha', pw), h('label', { class: 'f' }, 'Repita a nova senha', pw2)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => {
        if (pw.value !== pw2.value) return toast('As senhas não conferem.', true);
        try { await api('/me/password', { method: 'POST', body: { current: cur.value, password: pw.value } }); me = null; showLogin('Senha alterada. Entre com a nova senha.'); } catch (ex) { toast(ex.message, true); }
      } }, 'Salvar nova senha'))));
  }

  route();
})();
