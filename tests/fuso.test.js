'use strict';
// Datas e horários sempre no fuso local da filial, nunca no do servidor ou do aparelho.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { parseLocal } = require('../src/time');

const MANAUS = 'America/Manaus'; const SP = 'America/Sao_Paulo';
const MIN = 60_000;
let admin; let manaus; let sp; let survey; let question;

const addResponse = (branchId, at) => run('INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, channel, received_at) VALUES (?,?,?,?,?,?)', crypto.randomUUID(), survey, branchId, at, 'tablet', at).lastInsertRowid;

test.before(async () => {
  await start();
  makeUser('fuso@a.local', 'admin');
  admin = new Client(); await admin.login('fuso@a.local', 'SenhaForte123');
  manaus = (await admin.req('POST', '/api/admin/branches', { body: { code: 'MAO', name: 'Manaus', timezone: MANAUS } })).json.id;
  sp = (await admin.req('POST', '/api/admin/branches', { body: { code: 'SAO', name: 'São Paulo', timezone: SP } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Fuso', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  question = get('SELECT id FROM questions WHERE survey_id = ?', survey).id;
  for (const b of [manaus, sp]) await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: survey } });
});
test.after(stop);
test.beforeEach(() => run('DELETE FROM responses'));

test('o filtro por dia usa a meia-noite local de cada filial', async () => {
  // 23:30 do dia 05 em Manaus já é dia 06 em São Paulo; e 00:30 do dia 06 em São Paulo ainda é dia 05 em Manaus.
  addResponse(manaus, parseLocal('2026-03-05T23:30', MANAUS));
  addResponse(sp, parseLocal('2026-03-06T00:30', SP));
  const dia = async (d) => (await admin.req('GET', `/api/admin/responses?from=${d}&to=${d}`)).json.rows.map((r) => r.branch);
  assert.deepEqual(await dia('2026-03-05'), ['Manaus']);
  assert.deepEqual(await dia('2026-03-06'), ['São Paulo']);
});

test('a resposta traz o fuso da filial e a planilha mostra a hora local', async () => {
  addResponse(manaus, parseLocal('2026-03-05T08:15', MANAUS));
  const r = (await admin.req('GET', '/api/admin/responses')).json.rows[0];
  assert.equal(r.tz, MANAUS);
  const csv = (await admin.req('GET', '/api/admin/responses.csv')).text;
  assert.match(csv, /05\/03\/2026, 08:15/);
});

test('a evolução por dia usa o dia local da filial', async () => {
  const id = addResponse(manaus, parseLocal('2026-03-05T23:30', MANAUS));
  run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,?)', id, question, 9);
  const { trend } = (await admin.req('GET', '/api/admin/stats')).json;
  assert.deepEqual(trend.map((t) => t.day), ['2026-03-05']);
});

test('"todas as filiais" entra às 08:00 do relógio de cada filial', async () => {
  const moment = (await admin.req('POST', `/api/admin/surveys/${survey}/moments`, { body: { title: 'Todas', questions: [{ text: 'Todas?', type: 'nps', is_nps: true }] } })).json.id;
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await admin.req('POST', '/api/admin/schedules', { body: { surveyId: moment, branchId: null, startsAt: `${day}T08:00`, endsAt: `${day}T09:00` } })).status, 201);
  const { effectiveSurveyId } = require('../src/responses');
  const branch = (id) => get('SELECT * FROM branches WHERE id = ?', id);
  const eight = parseLocal(`${day}T08:00`, MANAUS);
  assert.equal(effectiveSurveyId(branch(manaus), eight + MIN), moment);
  assert.equal(effectiveSurveyId(branch(manaus), eight - MIN), survey, 'em Manaus ainda são 07:59, embora em São Paulo já sejam 08:59');
  const spEight = parseLocal(`${day}T08:00`, SP);
  assert.equal(effectiveSurveyId(branch(sp), spEight + MIN), moment);
  assert.equal(effectiveSurveyId(branch(sp), spEight + 61 * MIN), survey);
  run('DELETE FROM schedules');
});

test('o painel recebe o fuso da empresa e o da filial nos tablets', async () => {
  assert.ok((await admin.req('GET', '/api/admin/me')).json.companyTz);
  await admin.req('POST', '/api/admin/devices', { body: { branchId: manaus, name: 'Tablet A' } });
  const d = (await admin.req('GET', '/api/admin/devices')).json.find((x) => x.branch_id === manaus);
  assert.equal(d.tz, MANAUS);
});
