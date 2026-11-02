'use strict';
// Permissões: administrador irrevogável, tabela única do gestor e regras de gestor cadastrando gestor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { CATALOG } = require('../src/permissions');

const PW = 'SenhaForte123';
let admin; let criador; let criadorId; let b1; let b2; let adminId;
const allKeys = CATALOG.flatMap((g) => g.items).map((i) => i.key);
const table = async (over) => {
  const { gestor } = (await admin.req('GET', '/api/admin/permissions')).json;
  return admin.req('PUT', '/api/admin/permissions', { body: { gestor: { ...gestor, ...over } } });
};
const login = async (email) => { const c = new Client(); await c.login(email, PW); return c; };
const resetTable = () => run("DELETE FROM settings WHERE key = 'gestorPermissions'");

test.before(async () => {
  await start();
  adminId = makeUser('adm-p@a.local', 'admin');
  admin = await login('adm-p@a.local');
  b1 = (await admin.req('POST', '/api/admin/branches', { body: { code: 'P1', name: 'Filial Um' } })).json.id;
  b2 = (await admin.req('POST', '/api/admin/branches', { body: { code: 'P2', name: 'Filial Dois' } })).json.id;
  criadorId = (await admin.req('POST', '/api/admin/users', { body: { name: 'Gestor Criador', email: 'criador@a.local', password: PW, branches: [b1] } })).json.id;
  criador = await login('criador@a.local');
});
test.after(stop);
test.afterEach(resetTable);

test('a tabela e seu padrão: gestor mantém o que já fazia, sem excluir nada', async () => {
  const me = (await criador.req('GET', '/api/admin/me')).json.user.perms;
  for (const k of ['dashboard.view', 'cases.edit', 'responses.export', 'devices.manage', 'devices.revoke', 'branches.survey', 'users.create']) assert.equal(me[k], true, k);
  for (const k of ['surveys.edit', 'surveys.delete', 'schedules.manage', 'branches.edit', 'branches.delete', 'devices.delete', 'responses.delete']) assert.equal(me[k], false, k);
  assert.equal(me['admin.settings'], undefined);
});

test('administrador tem tudo, mesmo com a tabela do gestor toda desligada', async () => {
  const off = Object.fromEntries(allKeys.map((k) => [k, false]));
  assert.equal((await admin.req('PUT', '/api/admin/permissions', { body: { gestor: off } })).status, 200);
  const me = (await admin.req('GET', '/api/admin/me')).json.user.perms;
  for (const k of [...allKeys, 'admin.settings', 'admin.permissions', 'admin.audit']) assert.equal(me[k], true, k);
  assert.equal((await admin.req('GET', '/api/admin/stats')).status, 200);
  assert.equal((await criador.req('GET', '/api/admin/stats')).status, 403);
  assert.equal((await criador.req('GET', '/api/admin/users')).status, 403);
});

test('gestor não acessa nem altera permissões, configurações e auditoria', async () => {
  assert.equal((await criador.req('GET', '/api/admin/permissions')).status, 403);
  assert.equal((await criador.req('PUT', '/api/admin/permissions', { body: { gestor: {} } })).status, 403);
  assert.equal((await criador.req('PUT', '/api/admin/settings', { body: {} })).status, 403);
  assert.equal((await criador.req('GET', '/api/admin/audit')).status, 403);
});

test('a tabela liga e desliga cada ação no servidor, na hora', async () => {
  const csv = () => criador.req('GET', '/api/admin/responses.csv');
  assert.equal((await csv()).status, 200);
  await table({ 'responses.export': false });
  assert.equal((await csv()).status, 403);
  const d = (await admin.req('POST', '/api/admin/devices', { body: { branchId: b1, name: 'Tablet P' } })).json.id;
  assert.equal((await criador.req('DELETE', `/api/admin/devices/${d}`)).status, 403);
  await table({ 'devices.delete': true });
  assert.equal((await criador.req('DELETE', `/api/admin/devices/${d}`)).status, 200);
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'permissions.update'"));
});

test('ação liberada continua limitada às filiais do gestor', async () => {
  await table({ 'devices.delete': true, 'branches.delete': true });
  const outro = (await admin.req('POST', '/api/admin/devices', { body: { branchId: b2, name: 'Tablet Outro' } })).json.id;
  assert.equal((await criador.req('DELETE', `/api/admin/devices/${outro}`)).status, 404);
  assert.equal((await criador.req('DELETE', `/api/admin/branches/${b2}`)).status, 404);
  assert.equal((await criador.req('POST', `/api/admin/branches/${b2}/deactivate`)).status, 404);
});

test('sem ver o menu, as ações dele ficam desligadas; pedido incompleto é recusado', async () => {
  const r = await table({ 'cases.view': false, 'cases.edit': true });
  assert.equal(r.json.gestor['cases.edit'], false);
  assert.equal((await admin.req('PUT', '/api/admin/permissions', { body: { gestor: { 'cases.view': true } } })).status, 400);
});

test('gestor nunca vê administradores na lista', async () => {
  const list = (await criador.req('GET', '/api/admin/users')).json;
  assert.ok(list.every((u) => u.role === 'gestor'));
  assert.ok(!list.some((u) => u.id === adminId));
});

test('gestor cadastra só gestor, só nas filiais dele; perfil enviado é ignorado', async () => {
  const novo = await criador.req('POST', '/api/admin/users', { body: { name: 'Novo', email: 'novo-g@a.local', role: 'admin', password: PW, branches: [b1] } });
  assert.equal(novo.status, 201);
  const u = get('SELECT role, created_by FROM users WHERE id = ?', novo.json.id);
  assert.equal(u.role, 'gestor');
  assert.equal(u.created_by, criadorId);
  assert.equal((await criador.req('POST', '/api/admin/users', { body: { name: 'Fora', email: 'fora@a.local', password: PW, branches: [b2] } })).status, 403);
  assert.equal((await criador.req('POST', '/api/admin/users', { body: { name: 'Sem', email: 'sem@a.local', password: PW, branches: [] } })).status, 400);
});

test('gestor edita só quem cadastrou: nunca a si, quem o criou, administrador ou colega', async () => {
  const body = (over = {}) => ({ name: 'Nome Novo', email: 'x@a.local', branches: [b1], ...over });
  const criado = (await criador.req('POST', '/api/admin/users', { body: { name: 'Meu', email: 'meu@a.local', password: PW, branches: [b1] } })).json.id;
  const netoId = criado;
  const colega = (await admin.req('POST', '/api/admin/users', { body: { name: 'Colega', email: 'colega@a.local', password: PW, branches: [b1] } })).json.id;

  assert.equal((await criador.req('PUT', `/api/admin/users/${criado}`, { body: body({ email: 'meu@a.local', role: 'admin', active: false }) })).status, 200);
  const salvo = get('SELECT role, active, name FROM users WHERE id = ?', criado);
  assert.equal(salvo.role, 'gestor', 'não vira administrador');
  assert.equal(salvo.active, 0);
  assert.equal(salvo.name, 'Nome Novo');
  run('UPDATE users SET active = 1 WHERE id = ?', netoId);
  const neto = await login('meu@a.local'); // desativar derruba a sessão: entra depois de reativado

  assert.equal((await criador.req('PUT', `/api/admin/users/${criadorId}`, { body: body() })).status, 404, 'a si mesmo');
  assert.equal((await criador.req('PUT', `/api/admin/users/${colega}`, { body: body() })).status, 404, 'colega');
  assert.equal((await criador.req('PUT', `/api/admin/users/${adminId}`, { body: body() })).status, 404, 'administrador');
  assert.equal((await neto.req('PUT', `/api/admin/users/${criadorId}`, { body: body({ email: 'criador@a.local' }) })).status, 404, 'quem o criou');
  assert.equal((await criador.req('PUT', `/api/admin/users/${criado}`, { body: body({ email: 'meu@a.local', resetMfa: true }) })).status, 403);

  const lista = (await criador.req('GET', '/api/admin/users')).json;
  assert.equal(lista.find((u) => u.id === criado).can_edit, true);
  assert.equal(lista.find((u) => u.id === colega).can_edit, false);
});

test('filial dada pelo administrador fora do escopo do gestor é mantida na edição', async () => {
  const id = (await criador.req('POST', '/api/admin/users', { body: { name: 'Duas', email: 'duas@a.local', password: PW, branches: [b1] } })).json.id;
  run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', id, b2);
  assert.ok(!(await criador.req('GET', '/api/admin/users')).json.find((u) => u.id === id).branches.includes(b2), 'não mostra a filial alheia');
  assert.equal((await criador.req('PUT', `/api/admin/users/${id}`, { body: { name: 'Duas', email: 'duas@a.local', branches: [b1] } })).status, 200);
  assert.equal(get('SELECT COUNT(*) AS n FROM user_branches WHERE user_id = ?', id).n, 2);
});

test('o último administrador ativo não pode ser removido', async () => {
  const outro = (await admin.req('POST', '/api/admin/users', { body: { name: 'Adm Dois', email: 'adm2@a.local', role: 'admin', password: PW } })).json.id;
  const dois = await login('adm2@a.local');
  assert.equal((await dois.req('PUT', `/api/admin/users/${adminId}`, { body: { name: 'Adm', email: 'adm-p@a.local', role: 'gestor' } })).status, 200);
  assert.equal((await dois.req('PUT', `/api/admin/users/${outro}`, { body: { name: 'Adm Dois', email: 'adm2@a.local', role: 'gestor' } })).status, 400);
  run("UPDATE users SET role = 'admin' WHERE id = ?", adminId);
  admin = await login('adm-p@a.local');
});

test('gestor com agendamentos liberados não mexe em "todas as filiais"', async () => {
  await table({ 'schedules.manage': true });
  const local = (t) => new Date(t - 3 * 3_600_000).toISOString().slice(0, 16);
  const t = Date.now() + 86_400_000;
  const s = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa P', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  const m = (await admin.req('POST', `/api/admin/surveys/${s}/moments`, { body: { title: 'Momento P', questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  const body = (branchId) => ({ surveyId: m, branchId, startsAt: local(t), endsAt: local(t + 3_600_000) });
  assert.equal((await criador.req('POST', '/api/admin/schedules', { body: body(null) })).status, 403);
  assert.equal((await criador.req('POST', '/api/admin/schedules', { body: body(b2) })).status, 404);
  const mine = await criador.req('POST', '/api/admin/schedules', { body: body(b1) });
  assert.equal(mine.status, 201);
  assert.equal((await criador.req('DELETE', `/api/admin/schedules/${mine.json.id}`)).status, 200);
});
