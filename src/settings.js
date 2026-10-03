'use strict';
// Configurações gerais da empresa: identidade visual, ícones do menu e das respostas.
const { all, run, get } = require('./db');
const { bad, str } = require('./validate');
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
};

// Aceita somente texto (recusa listas/objetos que virariam texto por conversão automática).
function text(v, fallback, field) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw bad(`Valor de ${field} inválido.`);
  return v;
}

function getSettings() {
  const out = structuredClone(DEFAULTS);
  for (const { key, value } of all('SELECT key, value FROM settings')) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    try { out[key] = key === 'menuIcons' ? { ...DEFAULTS.menuIcons, ...JSON.parse(value) } : JSON.parse(value); } catch { /* ignora valor corrompido */ }
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
  };
}

module.exports = { DEFAULTS, getSettings, saveSettings, publicBranding };
