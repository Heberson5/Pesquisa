'use strict';
// Horários: uma resposta dada às 23h30 no horário do tablet pertence àquele dia em todo o sistema
// (filtros, gráfico diário, casos, CSV), qualquer que seja o fuso do servidor (na VPS ele costuma ser UTC).
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, get } = require('./helpers');
const { parseLocal } = require('../src/time');

let admin; let branchSP; let branchAM; let survey; let qNps; let tokSP; let tokAM;
// Ontem no calendário de Brasília (as respostas do tablet podem chegar até 30 dias depois).
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 86_400_000));
const next = new Date(Date.parse(day + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);

test.before(async () => {
  await start();
  makeUser('adm@tz.local', 'admin');
  admin = new Client(); await admin.login('adm@tz.local', 'SenhaForte123');
  branchSP = (await admin.req('POST', '/api/admin/branches', { body: { code: 'TZSP', name: 'Loja São Paulo', timezone: 'America/Sao_Paulo' } })).json.id;
  branchAM = (await admin.req('POST', '/api/admin/branches', { body: { code: 'TZAM', name: 'Loja Manaus', timezone: 'America/Manaus' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Fuso', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  qNps = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions[0].id;
  const pair = async (b) => {
    await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: survey } });
    const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Tab ' + b } });
    return (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  };
  tokSP = await pair(branchSP); tokAM = await pair(branchAM);
});
test.after(stop);

const send = (tok, at, value) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
  body: { uuid: crypto.randomUUID(), surveyId: survey, submittedAt: at, answers: [{ questionId: qNps, value }] } });

test('resposta às 23h30 no horário do tablet aparece naquele dia, não no seguinte', async () => {
  const at = parseLocal(`${day}T23:30`, 'America/Sao_Paulo'); // em UTC já é o dia seguinte
  assert.equal((await send(tokSP, at, 2)).status, 201);
  const q = (from, to) => `branchId=${branchSP}&from=${from}&to=${to}`;
  assert.equal((await admin.req('GET', `/api/admin/responses?${q(day, day)}`)).json.total, 1, 'aparece no dia certo');
  assert.equal((await admin.req('GET', `/api/admin/responses?${q(next, next)}`)).json.total, 0, 'não aparece no dia seguinte');
  const stats = (await admin.req('GET', `/api/admin/stats?${q(day, day)}`)).json;
  assert.equal(stats.totalResponses, 1);
  assert.deepEqual(stats.trend.map((t) => t.day), [day], 'gráfico diário no dia local');
  // O caso (nota 2) também está no dia certo.
  assert.equal((await admin.req('GET', `/api/admin/cases?status=&branchId=${branchSP}&from=${day}&to=${day}`)).json.total, 1);
  assert.equal((await admin.req('GET', `/api/admin/cases?status=&branchId=${branchSP}&from=${next}&to=${next}`)).json.total, 0);
  // CSV mostra a hora do tablet.
  const csv = (await admin.req('GET', `/api/admin/responses.csv?${q(day, day)}`)).text;
  assert.match(csv, new RegExp(`"${day.split('-').reverse().join('/')},? 23:30`));
});

test('cada filial usa o próprio fuso: 23h30 em Manaus é 00h30 em Brasília, mas conta no dia de Manaus', async () => {
  const at = parseLocal(`${day}T23:30`, 'America/Manaus');
  assert.equal((await send(tokAM, at, 9)).status, 201);
  const r = (await admin.req('GET', `/api/admin/responses?branchId=${branchAM}&from=${day}&to=${day}`)).json;
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].tz, 'America/Manaus', 'a tela recebe o fuso da filial para mostrar a hora local');
  assert.equal(get('SELECT local_day FROM responses WHERE id = ?', r.rows[0].id).local_day, day);
});
