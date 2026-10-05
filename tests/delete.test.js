'use strict';
// Exclusão de respostas (só administrador) e configurações de tela do tablet.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

let admin; let gestor; let branchA; let branchB; let survey; let q; let tokA; let tokB;
const kiosk = (tok, body) => new Client().req('POST', '/api/kiosk/responses', { body, headers: { Authorization: 'Bearer ' + tok } });
const send = (tok, nps) => kiosk(tok, { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q[0].id, value: nps }] });

test.before(async () => {
  await start();
  makeUser('adm@d.local', 'admin');
  admin = new Client(); await admin.login('adm@d.local', 'SenhaForte123');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'DA', name: 'Del A' } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'DB', name: 'Del B' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa exclusão', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  for (const b of [branchA, branchB]) await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  const pair = async (b) => { const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Tab ' + b } }); return (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token; };
  tokA = await pair(branchA); tokB = await pair(branchB);
  makeUser('gestor@d.local', 'gestor', 'SenhaForte123', [branchA]);
  gestor = new Client(); await gestor.login('gestor@d.local', 'SenhaForte123');
});
test.after(stop);

const count = (where = '1=1', ...p) => get(`SELECT COUNT(*) AS n FROM responses WHERE ${where}`, ...p).n;

test('gestor NÃO exclui respostas (nem uma, nem em lote); nada é apagado', async () => {
  await send(tokA, 4); await send(tokA, 9);
  const before = count();
  const id = get('SELECT id FROM responses LIMIT 1').id;
  assert.equal((await gestor.req('DELETE', `/api/admin/responses/${id}`)).status, 403);
  assert.equal((await gestor.req('POST', '/api/admin/responses/delete-filtered', { body: { confirm: 'EXCLUIR', filter: {} } })).status, 403);
  assert.equal((await new Client().req('DELETE', `/api/admin/responses/${id}`)).status, 401);
  assert.equal(count(), before);
});

test('administrador exclui uma resposta, com auditoria; id inexistente dá 404', async () => {
  const id = get('SELECT id FROM responses ORDER BY id LIMIT 1').id;
  assert.equal((await admin.req('DELETE', `/api/admin/responses/${id}`)).status, 200);
  assert.equal(get('SELECT COUNT(*) AS n FROM answers WHERE response_id = ?', id).n, 0, 'respostas das perguntas saem junto');
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'response.delete'"));
  assert.equal((await admin.req('DELETE', `/api/admin/responses/${id}`)).status, 404);
  assert.equal((await admin.req('DELETE', '/api/admin/responses/abc')).status, 400);
});

test('exclusão em lote exige a palavra EXCLUIR e respeita o filtro de filial', async () => {
  await send(tokB, 3); await send(tokB, 10); await send(tokA, 8);
  const a = count('branch_id = ?', branchA); const b = count('branch_id = ?', branchB);
  assert.ok(a > 0 && b > 0);
  assert.equal((await admin.req('POST', '/api/admin/responses/delete-filtered', { body: { filter: { branchId: String(branchB) } } })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/responses/delete-filtered', { body: { confirm: 'excluir', filter: { branchId: String(branchB) } } })).status, 400);
  assert.equal(count('branch_id = ?', branchB), b);
  const r = await admin.req('POST', '/api/admin/responses/delete-filtered', { body: { confirm: 'EXCLUIR', filter: { branchId: String(branchB) } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.deleted, b);
  assert.equal(count('branch_id = ?', branchB), 0);
  assert.equal(count('branch_id = ?', branchA), a, 'outra filial intacta');
});

test('configurações de tela: padrão ligado, validação e entrega ao tablet', async () => {
  const cfg = await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tokA } });
  assert.deepEqual(cfg.json.branding.screen, { keepAwake: true, dim: true, dimAfterSeconds: 30, dimLevel: 70 });
  const put = (screen) => admin.req('PUT', '/api/admin/settings', { body: { screen } });
  assert.equal((await put({ dimLevel: 5 })).status, 400);
  assert.equal((await put({ dimLevel: 99 })).status, 400);
  assert.equal((await put({ dimAfterSeconds: 1 })).status, 400);
  assert.equal((await put({ keepAwake: 'sim' })).status, 400);
  assert.equal((await put('x')).status, 400);
  assert.equal((await gestor.req('PUT', '/api/admin/settings', { body: { screen: { dim: false } } })).status, 403);
  assert.equal((await put({ dim: true, dimAfterSeconds: 60, dimLevel: 50 })).status, 200);
  const cfg2 = await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tokA } });
  assert.equal(cfg2.json.branding.screen.dimAfterSeconds, 60);
  assert.equal(cfg2.json.branding.screen.dimLevel, 50);
});
