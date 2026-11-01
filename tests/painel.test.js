'use strict';
// Cálculos do painel: NPS por resposta, datas no fuso da empresa e proteção do histórico ao editar perguntas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

let admin; let branch; let survey; let qs; let base;

// Grava direto no banco para controlar o horário exato. scores: uma nota por pergunta de NPS.
function respond(at, scores) {
  const rid = run("INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, received_at, channel) VALUES (?,?,?,?,?,'link')",
    crypto.randomUUID(), survey, branch, at, at).lastInsertRowid;
  scores.forEach((s, i) => run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,?)', rid, qs[i].id, s));
}
const putSurvey = (changes, extra = {}) => admin.req('PUT', `/api/admin/surveys/${survey}`, { body: { ...base, ...extra,
  questions: qs.map((q, i) => ({ text: q.text, type: q.type, is_nps: q.is_nps, ...(changes[i] || {}) })) } });

test.before(async () => {
  await start();
  makeUser('adm@p.local', 'admin');
  admin = new Client(); await admin.login('adm@p.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'PN', name: 'Painel' } })).json.id;
  base = { title: 'Pesquisa painel', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { ...base,
    questions: [{ text: 'Recomendaria?', type: 'nps', is_nps: true }, { text: 'Voltaria?', type: 'nps', is_nps: true }] } })).json.id;
  qs = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
});
test.after(stop);

test('com duas perguntas de NPS, cada resposta conta uma vez nos totais', async () => {
  respond(Date.UTC(2026, 0, 10, 15), [10, 0]);
  respond(Date.UTC(2026, 0, 10, 16), [0, 10]);
  respond(Date.UTC(2026, 0, 10, 17), [10]);
  const st = (await admin.req('GET', '/api/admin/stats?from=2026-01-10&to=2026-01-10')).json;
  assert.equal(st.totalResponses, 3);
  assert.equal(st.overall.total, 3, 'uma nota por resposta');
  assert.equal(st.overall.promoters, 2, 'vale a primeira pergunta respondida');
  assert.equal(st.overall.detractors, 1);
  assert.equal(st.scoreDist.reduce((t, d) => t + d.n, 0), 3);
  assert.equal(st.byBranch[0].total, 3);
  assert.equal(st.trend[0].responses, 3);
  assert.equal(st.byQuestion.find((q) => q.id === qs[0].id).total, 3, 'o detalhe por pergunta continua separado');
  assert.equal(st.byQuestion.find((q) => q.id === qs[1].id).total, 2);
});

test('filtro e evolução diária usam o dia do fuso da empresa', async () => {
  respond(Date.UTC(2026, 0, 16, 1), [9]); // 22h do dia 15 em São Paulo; dia 16 em UTC
  const st = (await admin.req('GET', '/api/admin/stats?from=2026-01-15&to=2026-01-15')).json;
  assert.equal(st.totalResponses, 1);
  assert.deepEqual(st.trend.map((t) => t.day), ['2026-01-15']);
  assert.equal((await admin.req('GET', '/api/admin/stats?from=2026-01-16&to=2026-01-16')).json.totalResponses, 0);
  assert.equal((await admin.req('GET', '/api/admin/stats?from=2026-02-31')).status, 400);
});

test('filial com meta e sem notas continua com a meta informada', async () => {
  run('UPDATE branches SET nps_goal = 50 WHERE id = ?', branch);
  const rid = run("INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, received_at, channel) VALUES (?,?,?,?,?,'link')",
    crypto.randomUUID(), survey, branch, Date.UTC(2026, 2, 1, 15), Date.UTC(2026, 2, 1, 15)).lastInsertRowid;
  assert.ok(rid);
  const b = (await admin.req('GET', '/api/admin/stats?from=2026-03-01&to=2026-03-01')).json.ranking[0];
  assert.equal(b.goal, 50);
  assert.equal(b.nps, null);
});

test('mudar texto ou marcação de NPS com respostas exige confirmação e fica na auditoria', async () => {
  for (const change of [{ text: 'Outra pergunta?' }, { is_nps: false }]) {
    const r = await putSurvey({ 1: change });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'HISTORY_CHANGE');
  }
  assert.equal(get('SELECT text FROM questions WHERE id = ?', qs[1].id).text, 'Voltaria?', 'nada muda sem confirmar');

  assert.equal((await putSurvey({}, { title: 'Pesquisa renomeada' })).status, 200, 'outros campos não pedem confirmação');
  assert.equal((await putSurvey({ 1: { text: 'Voltaria a nos procurar?' } }, { confirmHistory: true })).status, 200);
  assert.equal(get('SELECT text FROM questions WHERE id = ?', qs[1].id).text, 'Voltaria a nos procurar?');
  const log = get("SELECT detail FROM audit_log WHERE action = 'survey.update' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(log.detail).historyChanges, [{ question: 2, text: ['Voltaria?', 'Voltaria a nos procurar?'] }]);
});
