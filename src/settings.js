'use strict';
// Configurações gerais da empresa: identidade visual, ícones do menu e das respostas.
const { all, run, get } = require('./db');
const { bad, str, int } = require('./validate');
const { isEmail, validateWebhookUrl } = require('./notify');
const Icons = require('../public/shared/icons');

const HEX = /^#[0-9a-f]{6}$/i;
const MEDIA_ID = /^[a-f0-9]{32}$/;

const DEFAULTS = {
  companyName: 'Pesquisa de Satisfação',
  primaryColor: '#0f3d5e',
  accentColor: '#ffd166',
  logoMediaId: null,
  faviconMediaId: null,
  appIconMediaId: null,
  menuIcons: { ...Icons.MENU_DEFAULTS },
  defaultDisplay: 'numbers', // estilo padrão das escalas: números, carinhas ou ícones
  ratingIcon: 'star',
  colorScheme: 'bands', // cores por nível: faixas do NPS (vermelho/amarelo/verde) ou gradiente
  faceStyle: 'color', // carinhas coloridas ou monocromáticas
  requireAdminMfa: true, // 2FA obrigatório para administradores
  privacyText: 'Suas respostas são usadas apenas para melhorar nosso atendimento. Dados de contato só são coletados com sua autorização, ficam protegidos e podem ser excluídos a qualquer momento a seu pedido.',
  retention: { commentsMonths: 24, contactsMonths: 12, auditMonths: 24 },
  alerts: { detractorEmail: true, webhookUrl: null, whatsappTemplate: null, whatsappLanguage: 'pt_BR' },
  weeklyReport: { enabled: false, weekday: 1, hour: 8, extraEmails: [] },
  defaultNpsGoal: 50,
  offlineAlert: { enabled: true, minutes: 30 },
  // Tela do tablet: mantém acesa e escurece (economiza bateria) depois de um tempo sem toque.
  screen: { keepAwake: true, dim: true, dimAfterSeconds: 30, dimLevel: 70 },
};

const OBJECT_KEYS = ['menuIcons', 'retention', 'alerts', 'weeklyReport', 'offlineAlert', 'screen'];

// Aceita somente texto (recusa listas/objetos que virariam texto por conversão automática).
function text(v, fallback, field) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw bad(`Valor de ${field} inválido.`);
  return v;
}

function obj(v, field) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`Valor de ${field} inválido.`); }
function flag(v) { if (typeof v !== 'boolean') throw bad('Valor verdadeiro/falso inválido.'); return v; }
// Lista de e-mails: sem quebras de linha nem caracteres que permitam injeção de cabeçalho.
function emailList(v, max = 20) {
  if (!Array.isArray(v) || v.length > max) throw bad(`Informe no máximo ${max} e-mails.`);
  const out = [...new Set(v.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  for (const e of out) if (!isEmail(e)) throw bad(`E-mail inválido: ${e.slice(0, 60)}`);
  return out;
}

function getSettings() {
  const out = structuredClone(DEFAULTS);
  for (const { key, value } of all('SELECT key, value FROM settings')) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    try { out[key] = OBJECT_KEYS.includes(key) ? { ...DEFAULTS[key], ...JSON.parse(value) } : JSON.parse(value); } catch { /* ignora valor corrompido */ }
  }
  return out;
}

function mediaRef(v, field, { imagesOnly = true } = {}) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !MEDIA_ID.test(v)) throw bad(`Arquivo de ${field} inválido.`);
  const m = get('SELECT mime FROM media WHERE id = ?', v);
  if (!m) throw bad(`Arquivo de ${field} não encontrado.`);
  if (imagesOnly && !m.mime.startsWith('image/')) throw bad(`O ${field} precisa ser uma imagem.`);
  return v;
}

// Valida e grava. Só chaves conhecidas, só ícones da biblioteca, só cores #rrggbb.
function saveSettings(input) {
  if (!input || typeof input !== 'object') throw bad('Configurações inválidas.');
  const cur = getSettings();
  const next = {
    companyName: str(input.companyName ?? cur.companyName, { field: 'nome da empresa', min: 2, max: 60 }),
    primaryColor: text(input.primaryColor, cur.primaryColor, 'cor principal'),
    accentColor: text(input.accentColor, cur.accentColor, 'cor de destaque'),
    logoMediaId: mediaRef(input.logoMediaId !== undefined ? input.logoMediaId : cur.logoMediaId, 'logo'),
    faviconMediaId: mediaRef(input.faviconMediaId !== undefined ? input.faviconMediaId : cur.faviconMediaId, 'ícone do navegador'),
    appIconMediaId: mediaRef(input.appIconMediaId !== undefined ? input.appIconMediaId : cur.appIconMediaId, 'ícone do aplicativo'),
    menuIcons: { ...cur.menuIcons },
    defaultDisplay: text(input.defaultDisplay, cur.defaultDisplay, 'estilo padrão'),
    ratingIcon: text(input.ratingIcon, cur.ratingIcon, 'ícone de avaliação'),
    colorScheme: text(input.colorScheme, cur.colorScheme, 'esquema de cores'),
    faceStyle: input.faceStyle === 'mono' ? 'mono' : input.faceStyle === 'color' ? 'color' : cur.faceStyle,
  };
  if (!HEX.test(next.primaryColor) || !HEX.test(next.accentColor)) throw bad('Cor inválida (use o formato #RRGGBB).');
  if (!Icons.RATING_ICONS.includes(next.ratingIcon)) throw bad('Ícone de avaliação inválido.');
  if (!Icons.DISPLAYS.includes(next.defaultDisplay)) throw bad('Estilo padrão das respostas inválido.');
  if (!Icons.COLOR_SCHEMES.includes(next.colorScheme)) throw bad('Esquema de cores inválido.');
  if (input.menuIcons !== undefined) {
    if (typeof input.menuIcons !== 'object' || input.menuIcons === null) throw bad('Ícones de menu inválidos.');
    for (const [k, v] of Object.entries(input.menuIcons)) {
      if (!Object.hasOwn(Icons.MENU_DEFAULTS, k)) throw bad('Item de menu desconhecido.');
      if (!Icons.MENU_ICONS.includes(v)) throw bad('Ícone de menu inválido.');
      next.menuIcons[k] = v;
    }
  }
  if (input.requireAdminMfa !== undefined) {
    if (typeof input.requireAdminMfa !== 'boolean') throw bad('Valor inválido para 2FA obrigatório.');
    next.requireAdminMfa = input.requireAdminMfa;
  } else next.requireAdminMfa = cur.requireAdminMfa;
  next.privacyText = input.privacyText === undefined ? cur.privacyText : str(input.privacyText, { field: 'aviso de privacidade', min: 20, max: 1500 });
  next.retention = { ...cur.retention };
  if (input.retention !== undefined) {
    obj(input.retention, 'retenção');
    for (const [k, min, max] of [['commentsMonths', 1, 120], ['contactsMonths', 1, 60], ['auditMonths', 6, 120]]) {
      if (input.retention[k] !== undefined) next.retention[k] = int(input.retention[k], { field: 'prazo de retenção', min, max });
    }
  }
  next.alerts = { ...cur.alerts };
  if (input.alerts !== undefined) {
    obj(input.alerts, 'alertas');
    const a = input.alerts;
    if (a.detractorEmail !== undefined) next.alerts.detractorEmail = flag(a.detractorEmail);
    if (a.webhookUrl !== undefined) {
      const url = a.webhookUrl ? str(a.webhookUrl, { field: 'URL do webhook', max: 500 }) : null;
      if (url) { const e = validateWebhookUrl(url); if (e) throw bad(e); }
      next.alerts.webhookUrl = url;
    }
    if (a.whatsappTemplate !== undefined) {
      const t = a.whatsappTemplate ? String(a.whatsappTemplate) : null;
      if (t && !/^[a-z0-9_]{1,512}$/.test(t)) throw bad('Nome do modelo do WhatsApp inválido (use letras minúsculas, números e _).');
      next.alerts.whatsappTemplate = t;
    }
    if (a.whatsappLanguage !== undefined) {
      if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(String(a.whatsappLanguage))) throw bad('Idioma do modelo do WhatsApp inválido.');
      next.alerts.whatsappLanguage = a.whatsappLanguage;
    }
  }
  next.weeklyReport = { ...cur.weeklyReport };
  if (input.weeklyReport !== undefined) {
    obj(input.weeklyReport, 'relatório semanal');
    const w = input.weeklyReport;
    if (w.enabled !== undefined) next.weeklyReport.enabled = flag(w.enabled);
    if (w.weekday !== undefined) next.weeklyReport.weekday = int(w.weekday, { field: 'dia da semana', min: 0, max: 6 });
    if (w.hour !== undefined) next.weeklyReport.hour = int(w.hour, { field: 'hora', min: 0, max: 23 });
    if (w.extraEmails !== undefined) next.weeklyReport.extraEmails = emailList(w.extraEmails);
  }
  if (input.defaultNpsGoal !== undefined) next.defaultNpsGoal = input.defaultNpsGoal === null ? null : int(input.defaultNpsGoal, { field: 'meta de NPS', min: -100, max: 100 });
  else next.defaultNpsGoal = cur.defaultNpsGoal;
  next.offlineAlert = { ...cur.offlineAlert };
  if (input.offlineAlert !== undefined) {
    obj(input.offlineAlert, 'alerta de tablet');
    if (input.offlineAlert.enabled !== undefined) next.offlineAlert.enabled = flag(input.offlineAlert.enabled);
    if (input.offlineAlert.minutes !== undefined) next.offlineAlert.minutes = int(input.offlineAlert.minutes, { field: 'minutos sem sinal', min: 10, max: 1440 });
  }
  next.screen = { ...DEFAULTS.screen, ...cur.screen };
  if (input.screen !== undefined) {
    obj(input.screen, 'tela do tablet');
    const sc = input.screen;
    if (sc.keepAwake !== undefined) next.screen.keepAwake = flag(sc.keepAwake);
    if (sc.dim !== undefined) next.screen.dim = flag(sc.dim);
    if (sc.dimAfterSeconds !== undefined) next.screen.dimAfterSeconds = int(sc.dimAfterSeconds, { field: 'segundos para escurecer', min: 5, max: 3600 });
    if (sc.dimLevel !== undefined) next.screen.dimLevel = int(sc.dimLevel, { field: 'nível de escurecimento', min: 20, max: 90 });
  }
  for (const [k, v] of Object.entries(next)) {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  }
  return getSettings();
}

// Versão pública (sem login): somente o necessário para desenhar login e tablet.
function publicBranding() {
  const s = getSettings();
  return {
    companyName: s.companyName,
    primaryColor: s.primaryColor,
    accentColor: s.accentColor,
    logoUrl: s.logoMediaId ? `/media/${s.logoMediaId}` : null,
    defaultDisplay: s.defaultDisplay,
    ratingIcon: s.ratingIcon,
    colorScheme: s.colorScheme,
    faceStyle: s.faceStyle,
    privacyText: s.privacyText,
    screen: s.screen,
  };
}

module.exports = { DEFAULTS, getSettings, saveSettings, publicBranding, emailList };
