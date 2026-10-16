'use strict';
// Ramificação: conforme a resposta, a pesquisa pula para uma pergunta adiante ou encerra. O servidor refaz o
// caminho: resposta de pergunta pulada é descartada e a pergunta só é obrigatória quando está no caminho.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, get, run } = require('./helpers');

let admin; let survey; let q; let tok;
const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
const QUESTIONS = [
  { text: 'Nota?', type: 'nps', is_nps: true, jumps: [{ op: 'lte', value: 6, goto: 3 }, { op: 'gte', value: 9, goto: 'end' }] },
  { text: 'O que achou do preço?', type: 'single', options: ['Bom', 'Caro'] },
  { text: 'Voltaria?', type: 'yesno', jumps: [{ op: 'eq', value: 'nao', goto: 'end' }] },
  { text: 'O que deu errado?', type: 'text' },
  { text: 'Atendimento?', type: 'scale5' },
];

test.before(async () => {
  await start();
  makeUser('adm@r.local', 'admin');
  admin = new Client(); await admin.login('adm@r.local', 'SenhaForte123');
  const branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'RM', name: 'Loja Ramos' } })).json.id;
  const c = await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Ramificada', questions: QUESTIONS } });
  assert.equal(c.status, 201, c.text);
  survey = c.json.id;
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: survey } });
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab' } });
  tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
});
test.after(stop);

const send = (pairs, extra = {}) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
  body: { uuid: crypto.randomUUID(), surveyId: survey, answers: pairs.map(([i, value]) => ({ questionId: q[i].id, value })), ...extra } });
// Perguntas (posições) gravadas na última resposta.
const stored = () => {
  const r = get('SELECT id FROM responses ORDER BY id DESC LIMIT 1');
  const ids = q.map((x) => x.id);
  return JSON.parse(get('SELECT json_group_array(question_id) AS a FROM (SELECT question_id FROM answers WHERE response_id = ? ORDER BY question_id)', r.id).a).map((x) => ids.indexOf(x));
};

test('o editor recebe as regras pela posição e o tablet pelo id da pergunta', async () => {
  assert.deepEqual(q[0].jumps, QUESTIONS[0].jumps);
  assert.deepEqual(q[2].jumps, QUESTIONS[2].jumps);
  assert.deepEqual(q[1].jumps, []);
  const cfg = (await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok } })).json;
  assert.deepEqual(cfg.survey.questions[0].jumps, [{ op: 'lte', value: 6, goto: q[3].id }, { op: 'gte', value: 9, goto: 'end' }]);
});

test('detrator pula para "O que deu errado?" e não responde as perguntas do meio', async () => {
  assert.equal((await send([[0, 3], [3, 'Demora'], [4, 2]])).status, 201);
  assert.deepEqual(stored(), [0, 3, 4]);
  assert.equal((await send([[0, 3], [1, 'Caro'], [3, 'Demora'], [4, 2]])).status, 201, 'resposta de pergunta pulada é aceita…');
  assert.deepEqual(stored(), [0, 3, 4], '…mas descartada');
  assert.equal((await send([[0, 3], [4, 2]])).status, 400, 'pergunta do caminho é obrigatória');
});

test('promotor encerra na primeira pergunta', async () => {
  assert.equal((await send([[0, 10]])).status, 201);
  assert.equal((await send([[0, 10], [4, 5]])).status, 201);
  assert.deepEqual(stored(), [0]);
});

test('neutro segue a ordem e a segunda ramificação pode encerrar', async () => {
  assert.equal((await send([[0, 7], [1, 'Bom'], [2, 'nao']])).status, 201, '"Não" encerra');
  assert.equal((await send([[0, 7], [1, 'Bom'], [2, 'nao'], [4, 3]])).status, 201);
  assert.deepEqual(stored(), [0, 1, 2]);
  assert.equal((await send([[0, 7], [1, 'Bom'], [2, 'sim']])).status, 400, '"Sim" continua: faltam as próximas');
  assert.equal((await send([[0, 7], [1, 'Bom'], [2, 'sim'], [3, 'Nada'], [4, 4]])).status, 201);
});

test('regras inválidas são recusadas (para trás, para si mesma, fora da escala, em texto)', async () => {
  const two = (a, b = { text: 'B?', type: 'yesno' }) => [a, b];
  for (const qs of [
    two({ text: 'A?', type: 'nps', jumps: [{ op: 'lte', value: 6, goto: 0 }] }),
    two({ text: 'A?', type: 'nps', jumps: [{ op: 'lte', value: 6, goto: 2 }] }),
    two({ text: 'A?', type: 'nps', jumps: [{ op: 'lte', value: 6, goto: -1 }] }),
    two({ text: 'A?', type: 'nps', jumps: [{ op: 'lte', value: 6 }] }),
    two({ text: 'A?', type: 'nps', jumps: [{ op: 'lte', value: 11, goto: 1 }] }),
    two({ text: 'A?', type: 'nps', jumps: [{ op: 'has', value: 6, goto: 1 }] }),
    two({ text: 'A?', type: 'single', options: ['x', 'y'], jumps: [{ op: 'eq', value: 'z', goto: 'end' }] }),
    two({ text: 'A?', type: 'text', jumps: [{ op: 'eq', value: 'x', goto: 'end' }] }),
    [{ text: 'A?', type: 'nps' }, { text: 'B?', type: 'yesno', jumps: [{ op: 'eq', value: 'sim', goto: 0 }] }],
    two({ text: 'A?', type: 'nps', jumps: 'pular' }),
  ]) assert.equal((await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Inválida', questions: qs } })).status, 400, JSON.stringify(qs));
});

test('com respostas, as regras ainda podem mudar; a cópia leva as regras', async () => {
  const full = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json;
  const questions = full.questions.map((x, i) => ({ ...x, jumps: i === 0 ? [{ op: 'lte', value: 6, goto: 'end' }] : x.jumps }));
  const r = await admin.req('PUT', `/api/admin/surveys/${survey}`, { body: { ...base, title: full.title, questions } });
  assert.equal(r.status, 200, r.text);
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  assert.deepEqual(q[0].jumps, [{ op: 'lte', value: 6, goto: 'end' }]);
  assert.equal((await send([[0, 2]])).status, 201, 'detrator agora encerra');
  // Resposta guardada offline antes da mudança, pelo caminho antigo: não é perdida.
  const before = Date.now() - 3_600_000;
  run('UPDATE surveys SET updated_at = ? WHERE id = ?', before + 60_000, survey);
  assert.equal((await send([[0, 3], [3, 'Demora'], [4, 2]], { startedAt: before, submittedAt: before + 30_000 })).status, 201);
  assert.deepEqual(stored(), [0], 'pelas regras novas a nota 3 encerra: o resto é descartado');
  // Obrigatória do caminho: exigida de quem começou depois da mudança, não de quem começou antes.
  assert.equal((await send([[0, 7], [1, 'Bom']])).status, 400);
  assert.equal((await send([[0, 7], [1, 'Bom']], { startedAt: before, submittedAt: before + 30_000 })).status, 201);
  const dup = (await admin.req('POST', `/api/admin/surveys/${survey}/duplicate`)).json.id;
  const copy = (await admin.req('GET', `/api/admin/surveys/${dup}`)).json.questions;
  assert.deepEqual(copy.map((x) => x.jumps), q.map((x) => x.jumps));
});
