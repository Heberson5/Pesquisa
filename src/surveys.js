'use strict';
// Regras de negócio de pesquisas: tipos de pergunta, validação de respostas e NPS.
const { get, all } = require('./db');
const { bad, str } = require('./validate');

const QUESTION_TYPES = {
  nps: 'NPS (0 a 10)',
  scale5: 'Escala 1 a 5 (carinhas)',
  single: 'Escolha única',
  multi: 'Múltipla escolha',
  yesno: 'Sim / Não',
  text: 'Texto livre',
};

const MAX_OPTIONS = 12;
const Icons = require('../public/shared/icons');

// Formas de exibir uma escala. O valor gravado é sempre o número (0–10 ou 1–5),
// então o NPS é calculado igual qualquer que seja a aparência escolhida.
const DISPLAYS = { default: 'Padrão das configurações', numbers: 'Números coloridos', faces: 'Carinhas coloridas', icons: 'Ícones (estrelas, corações…)' };

// Idiomas disponíveis no tablet. O português é sempre o idioma base.
const LANGS = ['pt', 'en', 'es'];
const LANG_LABELS = { pt: 'Português', en: 'English', es: 'Español' };
const CONTACT_MODES = { never: 'Não perguntar', detractors: 'Só para quem deu nota de 0 a 6', always: 'Perguntar para todos' };

const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
function parseOptions(q) { return parseJson(q.options_json, []); }

function loadSurvey(surveyId) {
  const s = get('SELECT * FROM surveys WHERE id = ?', surveyId);
  if (!s) return null;
  s.languages = parseJson(s.languages, ['pt']).filter((l) => LANGS.includes(l));
  if (!s.languages.includes('pt')) s.languages.unshift('pt');
  s.i18n = parseJson(s.i18n, {});
  s.questions = all('SELECT * FROM questions WHERE survey_id = ? ORDER BY position, id', surveyId)
    .map((q) => ({ ...q, options: parseOptions(q), required: !!q.required, is_nps: !!q.is_nps, show_if: parseJson(q.show_if, null), i18n: parseJson(q.i18n, {}) }));
  return s;
}

// ---------------------------------------------------------------- perguntas condicionais
// show_if = { q: id da pergunta anterior, op, value }. Ex.: mostrar "O que podemos melhorar?" só se a nota NPS <= 6.
const OPS_BY_TYPE = { nps: ['lte', 'gte', 'eq'], scale5: ['lte', 'gte', 'eq'], yesno: ['eq'], single: ['eq', 'in'], multi: ['has'] };

function evalCondition(cond, value) {
  if (value === undefined || value === null) return false;
  switch (cond.op) {
    case 'lte': return value <= cond.value;
    case 'gte': return value >= cond.value;
    case 'eq': return value === cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(value);
    case 'has': return Array.isArray(value) && value.includes(cond.value);
    default: return false;
  }
}

// rawAnswers: Map(questionId -> valor bruto já validado) das perguntas anteriores.
function isVisible(q, rawAnswers) {
  return !q.show_if || evalCondition(q.show_if, rawAnswers.get(q.show_if.q));
}

// Condição vinda do editor: referencia a pergunta anterior pela posição (ref).
function normalizeCondition(input, index, previous) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad(`Condição da pergunta ${index + 1} inválida.`);
  const ref = input.ref;
  if (!Number.isInteger(ref) || ref < 0 || ref >= index) throw bad(`A condição da pergunta ${index + 1} deve depender de uma pergunta anterior.`);
  const target = previous[ref];
  const ops = OPS_BY_TYPE[target.type];
  if (!ops || !ops.includes(input.op)) throw bad(`Condição da pergunta ${index + 1} incompatível com a pergunta ${ref + 1}.`);
  let value = input.value;
  if (target.type === 'nps' || target.type === 'scale5') {
    const [min, max] = target.type === 'nps' ? [0, 10] : [1, 5];
    if (!Number.isInteger(value) || value < min || value > max) throw bad(`Valor da condição da pergunta ${index + 1} fora da escala.`);
  } else if (target.type === 'yesno') {
    if (value !== 'sim' && value !== 'nao') throw bad(`Valor da condição da pergunta ${index + 1} inválido.`);
  } else if (input.op === 'in') {
    if (!Array.isArray(value) || !value.length || !value.every((v) => target.options.includes(v))) throw bad(`Opções da condição da pergunta ${index + 1} inválidas.`);
    value = [...new Set(value)];
  } else if (!target.options.includes(value)) throw bad(`Opção da condição da pergunta ${index + 1} inválida.`);
  return { ref, op: input.op, value };
}

// ---------------------------------------------------------------- traduções
function normalizeI18n(input, languages, fields, { optionsCount = 0, where = '' } = {}) {
  const out = {};
  if (input === undefined || input === null) return out;
  if (typeof input !== 'object' || Array.isArray(input)) throw bad(`Traduções inválidas ${where}.`);
  for (const lang of Object.keys(input)) {
    if (lang === 'pt' || !LANGS.includes(lang) || !languages.includes(lang)) throw bad(`Idioma de tradução inválido ${where}.`);
    const t = input[lang];
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad(`Tradução inválida ${where}.`);
    const o = {};
    for (const [f, max] of fields) {
      const v = str(t[f], { field: `tradução (${lang})`, max, optional: true });
      if (v) o[f] = v;
    }
    if (optionsCount) {
      if (t.options !== undefined) {
        if (!Array.isArray(t.options) || t.options.length !== optionsCount) throw bad(`A tradução das opções ${where} deve ter ${optionsCount} itens.`);
        o.options = t.options.map((x) => str(x, { field: 'opção traduzida', min: 1, max: 80 }));
      }
    }
    if (Object.keys(o).length) out[lang] = o;
  }
  return out;
}

function normalizeQuestions(list, languages = ['pt']) {
  const out = [];
  list.forEach((input, i) => {
    const q = normalizeQuestion(input, i);
    q.show_if = normalizeCondition(input.show_if, i, out);
    q.i18n = normalizeI18n(input.i18n, languages, [['text', 300], ['help_text', 300]], { optionsCount: q.options.length, where: `da pergunta ${i + 1}` });
    out.push(q);
  });
  return out;
}

// Valida a definição de uma pergunta enviada pelo painel.
function normalizeQuestion(input, index) {
  if (!input || typeof input !== 'object') throw bad(`Pergunta ${index + 1} inválida.`);
  const type = input.type;
  if (!Object.hasOwn(QUESTION_TYPES, type)) throw bad(`Tipo da pergunta ${index + 1} inválido.`);
  const q = {
    text: str(input.text, { field: `pergunta ${index + 1}`, min: 3, max: 300 }),
    help_text: str(input.help_text, { field: 'texto de apoio', max: 300, optional: true }),
    type,
    required: input.required === false ? 0 : 1,
    is_nps: input.is_nps === true ? 1 : 0,
    options: [],
    display: 'default',
    icon: null,
  };
  if (type === 'nps' || type === 'scale5') {
    if (input.display !== undefined && !Object.hasOwn(DISPLAYS, input.display)) throw bad(`Estilo de exibição da pergunta ${index + 1} inválido.`);
    q.display = input.display || 'default';
    if (q.display === 'icons' && input.icon) {
      if (!Icons.RATING_ICONS.includes(input.icon)) throw bad(`Ícone da pergunta ${index + 1} inválido.`);
      q.icon = input.icon;
    }
  }
  if (q.is_nps && type !== 'nps') throw bad(`Somente perguntas do tipo NPS (0 a 10) podem entrar na análise de NPS (pergunta ${index + 1}).`);
  if (type === 'single' || type === 'multi') {
    if (!Array.isArray(input.options)) throw bad(`Informe as opções da pergunta ${index + 1}.`);
    const opts = input.options.map((o) => str(o, { field: 'opção', min: 1, max: 80 })).filter(Boolean);
    if (opts.length < 2 || opts.length > MAX_OPTIONS) throw bad(`A pergunta ${index + 1} deve ter entre 2 e ${MAX_OPTIONS} opções.`);
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) throw bad(`Opções repetidas na pergunta ${index + 1}.`);
    q.options = opts;
  }
  return q;
}

// Valida a resposta de um cliente para UMA pergunta. Retorna {num, text} ou null (pulada).
function normalizeAnswer(q, value) {
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) {
    if (q.required) throw bad('Resposta obrigatória ausente.');
    return null;
  }
  switch (q.type) {
    case 'nps':
    case 'scale5': {
      const [min, max] = q.type === 'nps' ? [0, 10] : [1, 5];
      if (!Number.isInteger(value) || value < min || value > max) throw bad('Nota fora da escala.');
      return { num: value, text: null };
    }
    case 'yesno':
      if (value !== 'sim' && value !== 'nao') throw bad('Resposta Sim/Não inválida.');
      return { num: value === 'sim' ? 1 : 0, text: null };
    case 'single':
      if (typeof value !== 'string' || !q.options.includes(value)) throw bad('Opção inválida.');
      return { num: null, text: value };
    case 'multi': {
      if (!Array.isArray(value) || value.length > q.options.length) throw bad('Opções inválidas.');
      const uniq = [...new Set(value)];
      if (!uniq.every((v) => typeof v === 'string' && q.options.includes(v))) throw bad('Opção inválida.');
      return { num: null, text: JSON.stringify(uniq) };
    }
    case 'text': {
      const s = str(value, { field: 'comentário', max: 1000, optional: !q.required });
      return s ? { num: null, text: s } : null;
    }
    default:
      throw bad('Tipo de pergunta desconhecido.');
  }
}

// NPS = %promotores (9-10) − %detratores (0-6). Neutros: 7-8.
function npsFromCounts(promoters, passives, detractors) {
  const total = promoters + passives + detractors;
  return {
    total, promoters, passives, detractors,
    nps: total ? Math.round(((promoters - detractors) / total) * 1000) / 10 : null,
  };
}

module.exports = {
  QUESTION_TYPES, DISPLAYS, LANGS, LANG_LABELS, CONTACT_MODES, OPS_BY_TYPE, loadSurvey, normalizeQuestion, normalizeQuestions,
  normalizeI18n, normalizeAnswer, npsFromCounts, parseOptions, isVisible, evalCondition,
};
