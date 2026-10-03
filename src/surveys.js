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

function parseOptions(q) {
  try { return q.options_json ? JSON.parse(q.options_json) : []; } catch { return []; }
}

function loadSurvey(surveyId) {
  const s = get('SELECT * FROM surveys WHERE id = ?', surveyId);
  if (!s) return null;
  s.questions = all('SELECT * FROM questions WHERE survey_id = ? ORDER BY position, id', surveyId)
    .map((q) => ({ ...q, options: parseOptions(q), required: !!q.required, is_nps: !!q.is_nps }));
  return s;
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

module.exports = { QUESTION_TYPES, DISPLAYS, loadSurvey, normalizeQuestion, normalizeAnswer, npsFromCounts, parseOptions };
