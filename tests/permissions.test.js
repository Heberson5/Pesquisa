'use strict';
// Perfis e permissões: cada menu/ação conferido no servidor, escopo de filiais e testes de ataque
// (aumentar o próprio acesso, dar perfil maior a outra pessoa, mexer no Administrador, ficar sem administrador).
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

let admin; let adminId; let branchA; let branchB; let survey; let roles;
const roleId = (name) => roles.find((r) => r.name === name).id;
const login = async (email) => { const c = new Client(); const r = await c.login(email, 'SenhaForte123'); assert.equal(r.status, 200, r.text); return c; };
async function userWithRole(email, rid, branches = []) {
  const r = await admin.req('POST', '/api/admin/users', { body: { name: email, email, password: 'SenhaForte123', roleId: rid, branches } });
  assert.equal(r.status, 201, r.text);
  return { id: r.json.id, c: await login(email) };
}
async function makeRole(body) {
  const r = await admin.req('POST', '/api/admin/roles', { body });
  assert.equal(r.status, 201, r.text);
  roles = (await admin.req('GET', '/api/admin/roles')).json.roles;
  return r.json.id;
}

test.before(async () => {
  await start();
  adminId = makeUser('adm@p.local', 'admin');
  admin = await login('adm@p.local');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'PA', name: 'Perm A' } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'PB', name: 'Perm B' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa perm', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  roles = (await admin.req('GET', '/api/admin/roles')).json.roles;
});
test.after(stop);

test('perfis padrão existem; Administrador fixo e Gestor com as permissões de sempre', async () => {
  const r = await admin.req('GET', '/api/admin/roles');
  assert.equal(r.status, 200);
  const adm = r.json.roles.find((x) => x.builtin === 'admin');
  const ges = r.json.roles.find((x) => x.builtin === 'gestor');
  assert.equal(adm.scope, 'all');
  assert.ok(adm.perms.includes('permissoes.excluir'));
  assert.equal(ges.scope, 'own');
  assert.ok(ges.perms.includes('respostas.csv') && !ges.perms.includes('respostas.excluir') && !ges.perms.includes('usuarios.ver'));
  assert.ok(r.json.catalog.modules.some((m) => m.key === 'cfg_lgpd'));
  // Usuário antigo (só com role = gestor) recebe o perfil Gestor de filial.
  makeUser('antigo@p.local', 'gestor', 'SenhaForte123', [branchA]);
  const me = (await (await login('antigo@p.local')).req('GET', '/api/admin/me')).json.user;
  assert.equal(me.access.roleName, 'Gestor de filial');
  assert.equal(me.access.scopeAll, false);
});

test('perfil "Somente leitura": vê a visão geral, mas o servidor recusa tudo o que não foi marcado', async () => {
  const rid = await makeRole({ name: 'Somente leitura', scope: 'all', perms: ['dashboard.ver'] });
  const { c } = await userWithRole('leitura@p.local', rid);
  assert.equal((await c.req('GET', '/api/admin/stats')).status, 200);
  for (const [m, u, body] of [['GET', '/api/admin/responses'], ['GET', '/api/admin/responses.csv'], ['GET', '/api/admin/report.pptx'], ['GET', '/api/admin/users'],
    ['GET', '/api/admin/audit'], ['GET', '/api/admin/devices'], ['GET', '/api/admin/cases'], ['GET', '/api/admin/schedules'], ['GET', '/api/admin/roles'],
    ['POST', '/api/admin/branches', { code: 'X1', name: 'Xis' }], ['PUT', `/api/admin/branches/${branchA}/survey`, { surveyId: survey }],
    ['POST', '/api/admin/privacy/search', { email: 'a@b.com' }], ['GET', '/api/admin/settings/delivery'], ['PUT', '/api/admin/settings', { companyName: 'Hack' }]]) {
    assert.equal((await c.req(m, u, { body })).status, 403, `${m} ${u}`);
  }
  // Configurações: recebe só o básico, sem integrações nem prazos.
  const st = (await c.req('GET', '/api/admin/settings')).json;
  assert.ok(st.companyName && !st.alerts && !st.retention && !st.privacyText);
  // Lista de filiais (para filtros) sem destinatários dos alertas.
  const brs = (await c.req('GET', '/api/admin/branches')).json;
  assert.ok(brs.length >= 2 && brs.every((b) => b.alert_emails === undefined && b.alert_phones === undefined));
});

test('marcar só "Excluir" já inclui "Ver"; permissão desconhecida é recusada', async () => {
  const rid = await makeRole({ name: 'Limpeza', scope: 'own', perms: ['respostas.excluir'] });
  assert.deepEqual(roles.find((r) => r.id === rid).perms, ['respostas.ver', 'respostas.excluir']);
  assert.equal((await admin.req('POST', '/api/admin/roles', { body: { name: 'Ruim', scope: 'all', perms: ['tudo.ver'] } })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/roles', { body: { name: 'Ruim', scope: 'nenhuma', perms: [] } })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/roles', { body: { name: 'limpeza', scope: 'own', perms: [] } })).status, 409, 'nome repetido');
});

test('escopo: perfil com filiais próprias não agenda campanha para todas nem vê outra filial', async () => {
  const rid = await makeRole({ name: 'Campanhas A', scope: 'own', perms: ['campanhas.incluir', 'campanhas.excluir', 'dashboard.ver'] });
  const { c } = await userWithRole('camp@p.local', rid, [branchA]);
  const when = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 16);
  assert.equal((await c.req('POST', '/api/admin/schedules', { body: { surveyId: survey, branchId: null, startsAt: when(1), endsAt: when(2) } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/schedules', { body: { surveyId: survey, branchId: branchB, startsAt: when(1), endsAt: when(2) } })).status, 404);
  const ok = await c.req('POST', '/api/admin/schedules', { body: { surveyId: survey, branchId: branchA, startsAt: when(1), endsAt: when(2) } });
  assert.equal(ok.status, 201, ok.text);
  const all = (await admin.req('POST', '/api/admin/schedules', { body: { surveyId: survey, branchId: null, startsAt: when(3), endsAt: when(4) } })).json.id;
  assert.equal((await c.req('DELETE', `/api/admin/schedules/${all}`)).status, 403, 'campanha de todas as filiais');
  assert.equal((await c.req('DELETE', `/api/admin/schedules/${ok.json.id}`)).status, 200);
  assert.equal((await c.req('GET', `/api/admin/stats?branchId=${branchB}`)).status, 404);
});

test('ataque: quem gerencia usuários não dá perfil maior que o seu, nem mexe no Administrador', async () => {
  const rid = await makeRole({ name: 'RH', scope: 'own', perms: ['usuarios.incluir', 'usuarios.editar', 'permissoes.incluir', 'permissoes.editar', 'dashboard.ver'] });
  const { id: rhId, c } = await userWithRole('rh@p.local', rid, [branchA]);
  // Perfil Administrador, perfil com todas as filiais e perfil com permissão que o RH não tem: recusados.
  const adm = roleId('Administrador');
  { const t = await c.req('POST', '/api/admin/users', { body: { name: 'Xavier', email: 'x1@p.local', password: 'SenhaForte123', roleId: adm } }); assert.equal(t.status, 403, t.text); }
  assert.equal((await c.req('POST', '/api/admin/users', { body: { name: 'Xavier', email: 'x2@p.local', password: 'SenhaForte123', role: 'admin' } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/users', { body: { name: 'Xavier', email: 'x3@p.local', password: 'SenhaForte123', roleId: roleId('Somente leitura') } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/users', { body: { name: 'Xavier', email: 'x4@p.local', password: 'SenhaForte123', roleId: roleId('Gestor de filial'), branches: [branchA] } })).status, 403,
    'gestor tem permissões que o RH não tem');
  // Criar perfil maior que o próprio (ou com todas as filiais) também é recusado.
  assert.equal((await c.req('POST', '/api/admin/roles', { body: { name: 'Mais', scope: 'own', perms: ['respostas.excluir'] } })).status, 403);
  assert.equal((await c.req('POST', '/api/admin/roles', { body: { name: 'Mais', scope: 'all', perms: ['dashboard.ver'] } })).status, 403);
  // Alterar o próprio perfil para ganhar acesso: recusado.
  assert.equal((await c.req('PUT', `/api/admin/roles/${rid}`, { body: { name: 'RH', scope: 'all', perms: ['usuarios.incluir'] } })).status, 403);
  assert.equal((await c.req('PUT', `/api/admin/users/${rhId}`, { body: { name: 'RH', email: 'rh@p.local', roleId: adm, branches: [branchA] } })).status, 400);
  // Alterar o administrador (trocar a senha dele para tomar a conta): recusado.
  assert.equal((await c.req('PUT', `/api/admin/users/${adminId}`, { body: { name: 'Adm', email: 'adm@p.local', role: 'admin', password: 'Invasao12345' } })).status, 403);
  // Pode criar perfil menor e dar a alguém da filial dele.
  const small = await c.req('POST', '/api/admin/roles', { body: { name: 'Painel A', scope: 'own', perms: ['dashboard.ver'] } });
  assert.equal(small.status, 201, small.text);
  const u = await c.req('POST', '/api/admin/users', { body: { name: 'Ana', email: 'ana@p.local', password: 'SenhaForte123', roleId: small.json.id, branches: [branchA] } });
  assert.equal(u.status, 201, u.text);
  // …mas não em filial que não enxerga.
  assert.equal((await c.req('PUT', `/api/admin/users/${u.json.id}`, { body: { name: 'Ana', email: 'ana@p.local', roleId: small.json.id, branches: [branchA, branchB] } })).status, 403);
  // O Administrador continua intacto.
  assert.equal(get('SELECT role FROM users WHERE id = ?', adminId).role, 'admin');
});

test('Administrador é fixo; perfis padrão e perfis em uso não são excluídos', async () => {
  const adm = roleId('Administrador');
  assert.equal((await admin.req('PUT', `/api/admin/roles/${adm}`, { body: { name: 'Administrador', scope: 'own', perms: [] } })).status, 400);
  assert.equal((await admin.req('DELETE', `/api/admin/roles/${adm}`)).status, 400);
  assert.equal((await admin.req('DELETE', `/api/admin/roles/${roleId('Gestor de filial')}`)).status, 400);
  assert.equal((await admin.req('DELETE', `/api/admin/roles/${roleId('Somente leitura')}`)).status, 400, 'em uso');
  const tmp = await makeRole({ name: 'Temporário', scope: 'own', perms: [] });
  assert.equal((await admin.req('DELETE', `/api/admin/roles/${tmp}`)).status, 200);
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'role.delete'"));
});

test('ninguém muda o próprio perfil nem se desativa; o último administrador não é rebaixado', async () => {
  const body = { name: 'Adm', email: 'adm@p.local', roleId: roleId('Gestor de filial') };
  assert.equal((await admin.req('PUT', `/api/admin/users/${adminId}`, { body })).status, 400);
  assert.equal((await admin.req('PUT', `/api/admin/users/${adminId}`, { body: { name: 'Adm', email: 'adm@p.local', role: 'admin', active: false } })).status, 400);
  assert.equal(get('SELECT role FROM users WHERE id = ?', adminId).role, 'admin');
});

test('mudar as permissões de um perfil vale na hora e fica na auditoria com o antes e depois', async () => {
  const rid = roleId('Somente leitura');
  const c = await login('leitura@p.local');
  assert.equal((await c.req('GET', '/api/admin/audit')).status, 403);
  const r = await admin.req('PUT', `/api/admin/roles/${rid}`, { body: { name: 'Somente leitura', scope: 'all', perms: ['dashboard.ver', 'auditoria.ver'] } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await c.req('GET', '/api/admin/audit')).status, 200, 'sem precisar entrar de novo');
  const log = JSON.parse(get("SELECT detail FROM audit_log WHERE action = 'role.update' ORDER BY id DESC LIMIT 1").detail);
  assert.deepEqual(log.added, ['auditoria.ver']);
  assert.deepEqual(log.removed, []);
});

test('caso: contato do cliente só para quem tem "Ver contato"; editar exige permissão', async () => {
  const pair = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchA, name: 'Tab perm' } });
  await admin.req('PUT', `/api/admin/branches/${branchA}/survey`, { body: { surveyId: survey } });
  const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: pair.json.code } })).json.token;
  const s = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json;
  await admin.req('PUT', `/api/admin/surveys/${survey}`, { body: { ...s, contact_mode: 'always' } });
  const sent = await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
    body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: s.questions[0].id, value: 2 }], contact: { consent: true, name: 'Maria', phone: '11999990000' } } });
  assert.equal(sent.status, 201, sent.text);
  const caseId = get('SELECT id FROM cases ORDER BY id DESC LIMIT 1').id;
  const rid = await makeRole({ name: 'Casos sem contato', scope: 'own', perms: ['casos.ver'] });
  const { c } = await userWithRole('casos@p.local', rid, [branchA]);
  const detail = (await c.req('GET', `/api/admin/cases/${caseId}`)).json;
  assert.equal(detail.contact, null);
  assert.equal(detail.contactHidden, true);
  assert.equal((await c.req('PUT', `/api/admin/cases/${caseId}`, { body: { status: 'resolvido' } })).status, 403);
  assert.equal((await admin.req('GET', `/api/admin/cases/${caseId}`)).json.contact.name, 'Maria');
});

test('configurações: cada aba só com a permissão dela', async () => {
  const rid = await makeRole({ name: 'Marketing', scope: 'all', perms: ['cfg_marca.editar'] });
  const { c } = await userWithRole('mkt@p.local', rid);
  const ok = await c.req('PUT', '/api/admin/settings', { body: { companyName: 'Empresa Nova' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.companyName, 'Empresa Nova');
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { companyName: 'Outra', retention: { contactsMonths: 1 } } })).status, 403);
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { requireAdminMfa: false } })).status, 403);
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: null } } })).status, 403);
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { foo: 1 } })).status, 400);
});

test('2FA obrigatório também para perfis que alteram usuários, permissões ou configurações', async () => {
  run("UPDATE settings SET value = 'true' WHERE key = 'requireAdminMfa'");
  try {
    const priv = new Client(); const r1 = await priv.login('rh@p.local', 'SenhaForte123');
    assert.equal(r1.json.mfaSetupRequired, true);
    const plain = new Client(); const r2 = await plain.login('leitura@p.local', 'SenhaForte123');
    assert.equal(r2.json.mfaSetupRequired, false);
  } finally { run("UPDATE settings SET value = 'false' WHERE key = 'requireAdminMfa'"); }
});
