'use strict';
// Biblioteca de ícones (traço 24x24). Desenhos baseados no conjunto Lucide (licença ISC).
// Usada pelo painel, pelo tablet e pelo servidor (que valida os nomes escolhidos nas configurações).
(function (root) {
  const ICONS = {
    // navegação / gestão
    layout: { label: 'Painel', d: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>' },
    'bar-chart': { label: 'Gráfico de barras', d: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>' },
    'pie-chart': { label: 'Gráfico de pizza', d: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>' },
    trending: { label: 'Tendência', d: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>' },
    gauge: { label: 'Medidor', d: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>' },
    activity: { label: 'Atividade', d: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
    target: { label: 'Alvo', d: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>' },
    inbox: { label: 'Caixa de entrada', d: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>' },
    list: { label: 'Lista', d: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>' },
    message: { label: 'Mensagem', d: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
    clipboard: { label: 'Prancheta', d: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>' },
    file: { label: 'Documento', d: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>' },
    building: { label: 'Prédio', d: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>' },
    store: { label: 'Loja', d: '<path d="M3 9 4.5 4h15L21 9"/><path d="M3 9h18a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 12v8h14v-8"/><path d="M10 20v-5h4v5"/>' },
    'map-pin': { label: 'Localização', d: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>' },
    tablet: { label: 'Tablet', d: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>' },
    phone: { label: 'Celular', d: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>' },
    monitor: { label: 'Monitor', d: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>' },
    users: { label: 'Pessoas', d: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    user: { label: 'Pessoa', d: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
    shield: { label: 'Escudo', d: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>' },
    history: { label: 'Histórico', d: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>' },
    lock: { label: 'Cadeado', d: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
    key: { label: 'Chave', d: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>' },
    settings: { label: 'Engrenagem', d: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
    sliders: { label: 'Ajustes', d: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>' },
    palette: { label: 'Paleta', d: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>' },
    user_cog: { label: 'Minha conta', d: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>' },
    calendar: { label: 'Calendário', d: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>' },
    bell: { label: 'Sino', d: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' },
    folder: { label: 'Pasta', d: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>' },
    briefcase: { label: 'Maleta', d: '<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>' },
    globe: { label: 'Globo', d: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>' },
    home: { label: 'Casa', d: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
    // avaliação (podem ser preenchidos)
    star: { label: 'Estrela', rating: true, d: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
    heart: { label: 'Coração', rating: true, d: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' },
    thumbs: { label: 'Joinha', rating: true, d: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>' },
    smile: { label: 'Sorriso', rating: true, d: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>' },
    flame: { label: 'Chama', rating: true, d: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' },
    zap: { label: 'Raio', rating: true, d: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
    award: { label: 'Medalha', rating: true, d: '<circle cx="12" cy="8" r="6"/><path d="M15.48 12.89 17 22l-5-3-5 3 1.52-9.11"/>' },
    crown: { label: 'Coroa', rating: true, d: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>' },
    circle: { label: 'Círculo', rating: true, d: '<circle cx="12" cy="12" r="9"/>' },
    check: { label: 'Visto', rating: true, d: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>' },
    // utilitários da interface (não aparecem como opção de menu)
    menu: { ui: true, d: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>' },
    'chevrons-left': { ui: true, d: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>' },
    'chevrons-right': { ui: true, d: '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>' },
    logout: { ui: true, d: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><path d="M21 12H9"/>' },
    download: { ui: true, d: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><path d="M12 15V3"/>' },
    slides: { ui: true, d: '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>' },
    plus: { ui: true, d: '<path d="M5 12h14"/><path d="M12 5v14"/>' },
    copy: { ui: true, d: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>' },
    edit: { ui: true, d: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>' },
    trash: { ui: true, d: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2"/>' },
    image: { ui: true, d: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>' },
    sun: { ui: true, d: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>' },
    moon: { ui: true, d: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>' },
    x: { ui: true, d: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>' },
    refresh: { ui: true, d: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>' },
    'arrow-up': { ui: true, d: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>' },
    'arrow-down': { ui: true, d: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>' },
  };

  // Itens do menu e ícone padrão de cada um.
  const MENU_DEFAULTS = {
    dashboard: 'layout', respostas: 'inbox', pesquisas: 'clipboard', filiais: 'store', dispositivos: 'tablet',
    usuarios: 'users', configuracoes: 'settings', auditoria: 'history', conta: 'user_cog',
  };

  const MENU_ICONS = Object.keys(ICONS).filter((k) => !ICONS[k].ui && !ICONS[k].rating);
  const RATING_ICONS = Object.keys(ICONS).filter((k) => ICONS[k].rating);

  // Gera o elemento SVG (no navegador). Os desenhos são constantes deste arquivo — nada vem do usuário.
  function svg(name, { size = 20, fill = false, cls = '' } = {}) {
    const icon = ICONS[name] || ICONS.circle;
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', size); el.setAttribute('height', size);
    el.setAttribute('fill', fill ? 'currentColor' : 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '2'); el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('aria-hidden', 'true');
    if (cls) el.setAttribute('class', cls);
    // DOMParser em modo SVG: o conteúdo é estático e confiável (definido acima).
    const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${icon.d}</svg>`, 'image/svg+xml');
    for (const child of [...doc.documentElement.childNodes]) el.append(document.importNode(child, true));
    return el;
  }

  // ---------------------------------------------------------------- cores e carinhas das escalas
  // Cores por nível de satisfação. "bands" = faixas do NPS (vermelho 0–6, amarelo 7–8, verde 9–10),
  // "gradient" = transição gradual do vermelho ao verde. A escala 1–5 usa 5 cores distintas.
  const LEVEL_STOPS = [[229, 72, 77], [241, 122, 58], [245, 165, 36], [140, 198, 63], [27, 138, 90]];
  const BANDS = { low: '#e5484d', mid: '#f5a524', high: '#1b8a5a' };
  function gradient(t) {
    const pos = Math.max(0, Math.min(1, t)) * (LEVEL_STOPS.length - 1);
    const i = Math.min(LEVEL_STOPS.length - 2, Math.floor(pos));
    const f = pos - i;
    return `rgb(${LEVEL_STOPS[i].map((v, k) => Math.round(v + (LEVEL_STOPS[i + 1][k] - v) * f)).join(',')})`;
  }
  // n = nota; isNps = escala 0–10 (senão 1–5)
  function levelColor(n, isNps, scheme = 'bands') {
    if (!isNps) return gradient((n - 1) / 4);
    if (scheme === 'gradient') return gradient(n / 10);
    return n <= 6 ? BANDS.low : n <= 8 ? BANDS.mid : BANDS.high;
  }
  const levelT = (n, isNps) => (isNps ? n / 10 : (n - 1) / 4);

  // Carinha em SVG: a boca vai de triste (t=0) a sorridente (t=1).
  function face(t, { color = gradient(t), mono = false, size } = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const ink = mono ? 'currentColor' : '#16263a';
    const out = el('svg', { viewBox: '0 0 100 100', class: 'face-svg', 'aria-hidden': 'true' });
    if (size) { out.setAttribute('width', size); out.setAttribute('height', size); }
    const curve = Math.round((t - 0.5) * 36);
    const mouthY = 66 - Math.max(0, curve) * 0.15;
    out.append(el('circle', mono ? { cx: 50, cy: 50, r: 44, fill: 'none', stroke: 'currentColor', 'stroke-width': 6 } : { cx: 50, cy: 50, r: 46, fill: color }),
      el('circle', { cx: 36, cy: 40, r: 6, fill: ink }), el('circle', { cx: 64, cy: 40, r: 6, fill: ink }),
      el('path', { d: `M30 ${mouthY} Q50 ${mouthY + curve} 70 ${mouthY}`, stroke: ink, 'stroke-width': 6, fill: 'none', 'stroke-linecap': 'round' }));
    return out;
  }

  const DISPLAYS = ['numbers', 'faces', 'icons'];
  const COLOR_SCHEMES = ['bands', 'gradient'];

  const api = { ICONS, MENU_DEFAULTS, MENU_ICONS, RATING_ICONS, DISPLAYS, COLOR_SCHEMES, svg, face, levelColor, levelT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Icons = api;
})(typeof window !== 'undefined' ? window : globalThis);
