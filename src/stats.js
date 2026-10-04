'use strict';
// Estatísticas e relatório: usados pelo painel, pela exportação PowerPoint e pelo relatório semanal por e-mail.
// O escopo do usuário (admin: todas as filiais; gestor: as dele) é aplicado em todas as consultas.
const { get, all } = require('./db');
const { bad, id, dateParam } = require('./validate');
const { scope, assertBranch, placeholders } = require('./scope');
const { loadSurvey, npsFromCounts } = require('./surveys');
const { getSettings } = require('./settings');
const { buildReport } = require('./report');
const { MEDIA_DIR } = require('./db');

// Monta o filtro comum (período, filial, pesquisa) respeitando o escopo do usuário.
function responseFilter(user, q) {
  const where = [];
  const params = [];
  const from = dateParam(q.from, 'de');
  const to = dateParam(q.to, 'até');
  if (from !== null) { where.push('r.submitted_at >= ?'); params.push(from); }
  if (to !== null) { where.push('r.submitted_at < ?'); params.push(to + 86_400_000); }
  if (q.surveyId) { where.push('r.survey_id = ?'); params.push(id(q.surveyId, 'pesquisa')); }
  if (q.channel) { if (!['tablet', 'link'].includes(q.channel)) throw bad('Canal inválido.'); where.push('r.channel = ?'); params.push(q.channel); }
  if (q.branchId) {
    const bid = id(q.branchId, 'filial');
    assertBranch(user, bid);
    where.push('r.branch_id = ?'); params.push(bid);
  }
  const s = scope(user);
  if (s) { where.push(s.length ? `r.branch_id IN (${placeholders(s)})` : '0'); params.push(...s); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const NPS_AGG = `SUM(CASE WHEN a.value_num >= 9 THEN 1 ELSE 0 END) AS promoters,
  SUM(CASE WHEN a.value_num BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS passives,
  SUM(CASE WHEN a.value_num <= 6 THEN 1 ELSE 0 END) AS detractors`;
const NPS_JOIN = 'JOIN answers a ON a.response_id = r.id JOIN questions q ON q.id = a.question_id AND q.is_nps = 1';
const npsRow = (row) => npsFromCounts(row?.promoters || 0, row?.passives || 0, row?.detractors || 0);

function computeStats(user, query) {
  const f = responseFilter(user, query);
  const totalResponses = get(`SELECT COUNT(*) AS n FROM responses r ${f.sql}`, ...f.params).n;
  const overall = npsRow(get(`SELECT ${NPS_AGG} FROM responses r ${NPS_JOIN} ${f.sql}`, ...f.params));
  const defaultGoal = getSettings().defaultNpsGoal;
  const byBranch = all(`SELECT b.id, b.name, b.nps_goal, COUNT(DISTINCT r.id) AS responses, ${NPS_AGG}
      FROM responses r JOIN branches b ON b.id = r.branch_id
      LEFT JOIN answers a ON a.response_id = r.id AND a.question_id IN (SELECT id FROM questions WHERE is_nps = 1)
      ${f.sql} GROUP BY b.id ORDER BY b.name`, ...f.params)
    .map((r) => {
      const n = npsRow(r);
      const goal = r.nps_goal ?? defaultGoal;
      return { id: r.id, name: r.name, responses: r.responses, ...n, goal, goalMet: goal === null || n.nps === null ? null : n.nps >= goal };
    });
  // Ranking: maior NPS primeiro (filiais sem nota de NPS ficam no fim).
  const ranking = [...byBranch].sort((a, b) => (b.nps ?? -1000) - (a.nps ?? -1000) || b.total - a.total).map((b, i) => ({ position: i + 1, ...b }));
  const byQuestion = all(`SELECT q.id, q.text, s.title AS survey, ${NPS_AGG}
      FROM responses r ${NPS_JOIN} JOIN surveys s ON s.id = q.survey_id ${f.sql} GROUP BY q.id ORDER BY s.title, q.position`, ...f.params)
    .map((r) => ({ id: r.id, text: r.text, survey: r.survey, ...npsRow(r) }));
  const trend = all(`SELECT date(r.submitted_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(DISTINCT r.id) AS responses, ${NPS_AGG}
      FROM responses r LEFT JOIN answers a ON a.response_id = r.id AND a.question_id IN (SELECT id FROM questions WHERE is_nps = 1)
      ${f.sql} GROUP BY day ORDER BY day`, ...f.params)
    .map((r) => ({ day: r.day, responses: r.responses, nps: npsRow(r).nps }));
  const scoreDist = all(`SELECT a.value_num AS score, COUNT(*) AS n FROM responses r ${NPS_JOIN} ${f.sql} GROUP BY a.value_num`, ...f.params);
  const comments = all(`SELECT r.submitted_at, b.name AS branch, q.text AS question, a.value_text AS comment
      FROM responses r JOIN answers a ON a.response_id = r.id JOIN questions q ON q.id = a.question_id AND q.type = 'text'
      JOIN branches b ON b.id = r.branch_id ${f.sql} ORDER BY r.submitted_at DESC LIMIT 15`, ...f.params);
  const channels = all(`SELECT r.channel, COUNT(*) AS n FROM responses r ${f.sql} GROUP BY r.channel`, ...f.params);
  return { totalResponses, overall, byBranch, ranking, defaultGoal, byQuestion, trend, scoreDist, comments, channels };
}

// Distribuição de respostas por pergunta de UMA pesquisa.
function computeBreakdown(user, survey, query) {
  const f = responseFilter(user, { ...query, surveyId: String(survey.id) });
  const rows = all(`SELECT a.question_id, a.value_num, a.value_text, COUNT(*) AS n FROM responses r
      JOIN answers a ON a.response_id = r.id ${f.sql} AND (SELECT type FROM questions WHERE id = a.question_id) <> 'text'
      GROUP BY a.question_id, a.value_num, a.value_text`, ...f.params);
  return survey.questions.filter((q) => q.type !== 'text').map((q) => {
    const counts = {};
    for (const r of rows.filter((x) => x.question_id === q.id)) {
      if (q.type === 'multi') for (const o of JSON.parse(r.value_text)) counts[o] = (counts[o] || 0) + r.n;
      else if (q.type === 'yesno') counts[r.value_num ? 'Sim' : 'Não'] = r.n;
      else counts[r.value_text ?? r.value_num] = r.n;
    }
    return { id: q.id, text: q.text, type: q.type, is_nps: q.is_nps, options: q.options, counts };
  });
}


// Gera o .pptx do período/filtro, no escopo do usuário.
async function reportFor(user, query, generatedBy) {
  const stats = computeStats(user, query);
  const f = responseFilter(user, query);
  const surveyIds = query.surveyId ? [id(query.surveyId, 'pesquisa')]
    : all(`SELECT r.survey_id, COUNT(*) AS n FROM responses r ${f.sql} GROUP BY r.survey_id ORDER BY n DESC LIMIT 3`, ...f.params).map((r) => r.survey_id);
  const surveys = surveyIds.map(loadSurvey).filter(Boolean).map((s) => ({ title: s.title, questions: computeBreakdown(user, s, query) }));
  const branchName = query.branchId ? get('SELECT name FROM branches WHERE id = ?', id(query.branchId, 'filial'))?.name : null;
  const buffer = await buildReport({
    settings: getSettings(), stats, surveys, mediaDir: MEDIA_DIR,
    filters: { from: query.from || null, to: query.to || null, branch: branchName, survey: query.surveyId ? surveys[0]?.title : null },
    generatedBy,
  });
  return { buffer, stats };
}

module.exports = { responseFilter, computeStats, computeBreakdown, reportFor, NPS_AGG, NPS_JOIN, npsRow };
