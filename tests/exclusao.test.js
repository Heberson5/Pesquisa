'use strict';
// Excluir tablets e filiais: histórico preservado, agendamentos protegidos e só administrador.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

const uuid = () => crypto.randomUUID();
let admin; let gestor; let survey; let n = 0;

const mkBranch = async () => (await admin.req('POST', '/api/admin/branches', { body: { code: `EX${++n}`, name: `Filial ${n}` } })).json.id;
const mkDevice = async (branchId, name = 'Tablet A') => (await admin.req('POST', '/api/admin/devices', { body: { branchId, name } })).json.id;
const addResponse = (branchId, deviceId = null) => Number(run('INSERT INTO responses (uuid, survey_id, branch_id, device_id, submitted_at, channel, received_at) VALUES (?,?,?,?,?,?,?)',
  uuid(), survey, branchId, deviceId, Date.now(), 'tablet', Date.now()).lastInsertRowid);

test.before(async () => {
  await start();
  makeUser('adm-ex@a.local', 'admin');
  admin = new Client(); await admin.login('adm-ex@a.local', 'SenhaForte123');
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa Ex', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
});
test.after(stop);

test('excluir tablet mantém as respostas com o nome dele e corta o acesso', async () => {
  const b = await mkBranch();
  const created = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Recepção' } });
  const d = created.json.id;
  const { token } = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: created.json.code } })).json;
  const r = addResponse(b, d);
  assert.equal((await admin.req('DELETE', `/api/admin/devices/${d}`)).status, 200);
  assert.equal(get('SELECT 1 AS x FROM devices WHERE id = ?', d), undefined);
  const saved = get('SELECT device_id, device_label, branch_id FROM responses WHERE id = ?', r);
  assert.equal(saved.device_id, null);
  assert.equal(saved.device_label, 'Recepção');
  assert.equal(saved.branch_id, b);
  assert.equal((await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'device.delete'"));
});

test('filial sem respostas é excluída com seus tablets', async () => {
  const b = await mkBranch();
  const d = await mkDevice(b);
  assert.equal((await admin.req('DELETE', `/api/admin/branches/${b}`)).status, 200);
  assert.equal(get('SELECT 1 AS x FROM branches WHERE id = ?', b), undefined);
  assert.equal(get('SELECT 1 AS x FROM devices WHERE id = ?', d), undefined);
});

test('filial com respostas não é excluída, mas pode ser desativada', async () => {
  const b = await mkBranch();
  addResponse(b);
  const del = await admin.req('DELETE', `/api/admin/branches/${b}`);
  assert.equal(del.status, 409);
  assert.match(del.json.error, /Desative/);
  assert.ok(get('SELECT 1 AS x FROM branches WHERE id = ?', b));
  assert.equal((await admin.req('POST', `/api/admin/branches/${b}/deactivate`)).status, 200);
  assert.equal(get('SELECT active FROM branches WHERE id = ?', b).active, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM responses WHERE branch_id = ?', b).n, 1);
  assert.equal((await admin.req('GET', '/api/admin/branches')).json.find((x) => x.id === b).responses, 1);
});

test('filial com agendamento pendente não é excluída', async () => {
  const b = await mkBranch();
  const now = Date.now();
  const s = run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', survey, b, now + 3_600_000, now + 7_200_000, now).lastInsertRowid;
  assert.equal((await admin.req('DELETE', `/api/admin/branches/${b}`)).status, 409);
  run('DELETE FROM schedules WHERE id = ?', s);
  assert.equal((await admin.req('DELETE', `/api/admin/branches/${b}`)).status, 200);
});

test('gestor não exclui tablet nem filial, nem desativa filial', async () => {
  const b = await mkBranch();
  const d = await mkDevice(b);
  makeUser('ges-ex@a.local', 'gestor', 'SenhaForte123', [b]);
  gestor = new Client(); await gestor.login('ges-ex@a.local', 'SenhaForte123');
  assert.equal((await gestor.req('DELETE', `/api/admin/devices/${d}`)).status, 403);
  assert.equal((await gestor.req('DELETE', `/api/admin/branches/${b}`)).status, 403);
  assert.equal((await gestor.req('POST', `/api/admin/branches/${b}/deactivate`)).status, 403);
  assert.ok(get('SELECT 1 AS x FROM devices WHERE id = ?', d));
});

test('item inexistente responde 404', async () => {
  assert.equal((await admin.req('DELETE', '/api/admin/devices/99999')).status, 404);
  assert.equal((await admin.req('DELETE', '/api/admin/branches/99999')).status, 404);
  assert.equal((await admin.req('POST', '/api/admin/branches/99999/deactivate')).status, 404);
});
