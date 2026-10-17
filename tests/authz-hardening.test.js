'use strict';
// Testes de ataque no painel (auditoria de segurança): exportação grande sem travar o servidor, destinatários de
// alerta, LGPD e auditoria só com acesso a todas as filiais, destinatários da empresa toda só pelo administrador,
// tomada de conta por gestor de filial, auditoria das configurações, upload, perfis, fila de envios e alertas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { start, stop, Client, makeUser, run, get, base } = require('./helpers');
const { MEDIA_DIR } = require('../src/db');
const { isPublicIp } = require('../src/netguard');
const { customerText, whatsappFor } = require('../src/templates');

const PW = 'SenhaForte123';
let admin; let branchA; let branchB; let survey; let q; let tokA;
const login = async (email) => { const c = new Client(); const r = await c.login(email, PW); assert.equal(r.status, 200, r.text); return c; };
async function userWithRole(email, perms, { scope = 'own', branches = [] } = {}) {
  const role = await admin.req('POST', '/api/admin/roles', { body: { name: 'R ' + email, scope, perms } });
  assert.equal(role.status, 201, role.text);
  const u = await admin.req('POST', '/api/admin/users', { body: { name: email, email, password: PW, roleId: role.json.id, branches } });
  assert.equal(u.status, 201, u.text);
  return { id: u.json.id, roleId: role.json.id, c: await login(email) };
}

test.before(async () => {
  await start();
  makeUser('adm@az.local', 'admin');
  admin = await login('adm@az.local');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'ZA', name: 'Authz A' } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'ZB', name: 'Authz B' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Authz', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30, contact_mode: 'detractors',
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }, { text: 'Comentário', type: 'text', required: false }] } })).json.id;
  for (const b of [branchA, branchB]) await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchA, name: 'Tab A' } });
  tokA = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
});
test.after(stop);

const kiosk = (body) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tokA },
  body: { uuid: crypto.randomUUID(), surveyId: survey, ...body } });

test('exportação CSV grande sai inteira, em blocos, e tem limite por pessoa', async () => {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  for (let i = 0; i < 1300; i++) {
    const r = run('INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, received_at, channel, local_day) VALUES (?,?,?,?,?,?,?)', crypto.randomUUID(), survey, branchB, now - i * 1000, now, 'tablet', day);
    run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,?)', r.lastInsertRowid, q[0].id, i % 11);
  }
  const csv = await admin.req('GET', `/api/admin/responses.csv?branchId=${branchB}&from=${day}&to=${day}`);
  assert.equal(csv.status, 200);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines.length, 1301, 'cabeçalho + 1300 linhas');
  assert.match(lines[0], /Nota\?/);
  const c = await login('adm@az.local');
  let last;
  for (let i = 0; i < 11; i++) last = await c.req('GET', `/api/admin/responses.csv?branchId=${branchA}`);
  assert.equal(last.status, 429);
});

test('destinatários de alerta da filial (recebem o contato do cliente) só mudam com "Ver contato do cliente"', async () => {
  const { c } = await userWithRole('filial@az.local', ['filiais.ver', 'filiais.editar'], { branches: [branchA] });
  const cur = (await c.req('GET', '/api/admin/branches')).json.find((b) => b.id === branchA);
  const body = { code: 'ZA', name: 'Authz A renomeada', alert_emails: JSON.parse(cur.alert_emails || '[]'), alert_phones: JSON.parse(cur.alert_phones || '[]') };
  assert.equal((await c.req('PUT', `/api/admin/branches/${branchA}`, { body })).status, 200, 'editar o nome continua permitido');
  assert.equal((await c.req('PUT', `/api/admin/branches/${branchA}`, { body: { ...body, alert_emails: ['espiao@fora.example'] } })).status, 403);
});

test('LGPD (titular) exige acesso a todas as filiais; perfil com filiais próprias não recebe essa permissão', async () => {
  assert.equal((await admin.req('POST', '/api/admin/roles', { body: { name: 'LGPD own', scope: 'own', perms: ['cfg_lgpd.titular'] } })).status, 400);
  // Perfil antigo (criado antes desta regra) com filiais próprias: o servidor recusa mesmo assim.
  const { roleId, c } = await userWithRole('lgpd@az.local', ['cfg_lgpd.ver'], { branches: [branchA] });
  run('UPDATE roles SET perms = ? WHERE id = ?', JSON.stringify(['cfg_lgpd.ver', 'cfg_lgpd.titular']), roleId);
  assert.equal((await c.req('POST', '/api/admin/privacy/search', { body: { phone: '11988887777' } })).status, 403);
});

test('e-mails extras do relatório e webhook (dados de todas as filiais) só pelo administrador', async () => {
  const { c } = await userWithRole('alertas@az.local', ['cfg_alertas.ver', 'cfg_alertas.editar'], { scope: 'all' });
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { weeklyReport: { extraEmails: ['espiao@fora.example'] } } })).status, 403);
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: 'https://hooks.fora.example/x' } } })).status, 403);
  assert.equal((await c.req('PUT', '/api/admin/settings', { body: { defaultNpsGoal: 70 } })).status, 200, 'o resto da aba continua editável');
  const n = (await c.req('GET', '/api/admin/settings/notifications')).json;
  assert.ok(n.webhookSecret, 'quem edita vê o segredo');
  const { c: viewer } = await userWithRole('alertasver@az.local', ['cfg_alertas.ver'], { scope: 'all' });
  assert.equal((await viewer.req('GET', '/api/admin/settings/notifications')).json.webhookSecret, null, 'só ver: segredo escondido');
});

test('segredo do webhook pode ser trocado pelo administrador', async () => {
  const before = (await admin.req('GET', '/api/admin/settings/notifications')).json.webhookSecret;
  const r = await admin.req('POST', '/api/admin/settings/webhook-secret/rotate');
  assert.equal(r.status, 200);
  assert.notEqual(r.json.webhookSecret, before);
  assert.equal((await admin.req('GET', '/api/admin/settings/notifications')).json.webhookSecret, r.json.webhookSecret);
});

test('gestor de filial não toma a conta de quem não tem filial, nem troca a própria senha pelo cadastro', async () => {
  const { id: rhId, c } = await userWithRole('rh@az.local', ['usuarios.ver', 'usuarios.editar'], { branches: [branchA] });
  const orphan = makeUser('orfao@az.local', 'gestor');
  run('UPDATE users SET role_id = (SELECT id FROM roles WHERE name = ?) WHERE id = ?', 'R rh@az.local', orphan);
  const r = await c.req('PUT', `/api/admin/users/${orphan}`, { body: { name: 'Órfão', email: 'tomado@az.local', password: 'Invasao12345', roleId: get('SELECT role_id FROM users WHERE id = ?', orphan).role_id, branches: [] } });
  assert.equal(r.status, 403);
  const self = await c.req('PUT', `/api/admin/users/${rhId}`, { body: { name: 'RH', email: 'rh@az.local', password: 'NovaSenha12345', roleId: get('SELECT role_id FROM users WHERE id = ?', rhId).role_id, branches: [branchA] } });
  assert.equal(self.status, 400);
});

test('alteração das configurações fica na auditoria com antes e depois', async () => {
  await admin.req('PUT', '/api/admin/settings', { body: { requireAdminMfa: false } });
  await admin.req('PUT', '/api/admin/settings', { body: { privacyText: 'Texto de privacidade novo para o teste.' } });
  const a = get("SELECT detail FROM audit_log WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1");
  assert.match(a.detail, /privacyText/);
  assert.match(a.detail, /Texto de privacidade novo/);
});

test('upload com nome de arquivo malformado é recusado sem deixar arquivo no disco', async () => {
  const before = fs.readdirSync(MEDIA_DIR).length;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const r = await admin.req('POST', '/api/admin/media', { raw: png, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': '%E0%A4%A' } });
  assert.equal(r.status, 400);
  assert.equal(fs.readdirSync(MEDIA_DIR).length, before);
});

test('lista de pesquisas exige permissão; auditoria exige acesso a todas as filiais', async () => {
  const { c } = await userWithRole('casos@az.local', ['casos.ver'], { branches: [branchA] });
  assert.equal((await c.req('GET', '/api/admin/surveys')).status, 403);
  const { c: aud } = await userWithRole('aud@az.local', ['auditoria.ver', 'dashboard.ver'], { branches: [branchA] });
  assert.equal((await aud.req('GET', '/api/admin/audit')).status, 403);
  const list = (await aud.req('GET', '/api/admin/surveys')).json.find((s) => s.id === survey);
  const all = (await admin.req('GET', '/api/admin/surveys')).json.find((s) => s.id === survey);
  assert.ok(list.responses < all.responses, 'contagem só das filiais da pessoa');
});

test('gestor de filial não altera perfil padrão nem perfil usado em outras filiais', async () => {
  const { c } = await userWithRole('perm@az.local', ['permissoes.ver', 'permissoes.incluir', 'permissoes.editar', 'dashboard.ver'], { branches: [branchA] });
  const roles = (await admin.req('GET', '/api/admin/roles')).json.roles;
  const gestor = roles.find((r) => r.builtin === 'gestor');
  assert.equal((await c.req('PUT', `/api/admin/roles/${gestor.id}`, { body: { name: gestor.name, scope: 'own', perms: ['dashboard.ver'] } })).status, 403);
  const mine = await c.req('POST', '/api/admin/roles', { body: { name: 'Painel da A', scope: 'own', perms: ['dashboard.ver'] } });
  assert.equal(mine.status, 201, 'criar perfil menor continua permitido');
  assert.equal((await c.req('PUT', `/api/admin/roles/${mine.json.id}`, { body: { name: 'Painel da A', scope: 'own', perms: ['dashboard.ver'] } })).status, 200);
});

test('exclusão do titular apaga os alertas com o contato dele na fila de envios', async () => {
  run("INSERT INTO settings (key, value) VALUES ('alerts', ?) ON CONFLICT(key) DO NOTHING", JSON.stringify({ detractorEmail: true }));
  await admin.req('PUT', `/api/admin/branches/${branchA}`, { body: { code: 'ZA', name: 'Authz A', alert_emails: ['loja.a@empresa.com'] } });
  const r = await kiosk({ answers: [{ questionId: q[0].id, value: 2 }], contact: { name: 'Maria Titular', email: 'maria.titular@cliente.com', consent: true } });
  assert.equal(r.status, 201, r.text);
  assert.ok(get("SELECT 1 FROM outbox WHERE body_html LIKE '%maria.titular@cliente.com%'"), 'alerta com o contato na fila');
  const e = await admin.req('POST', '/api/admin/privacy/erase', { body: { email: 'maria.titular@cliente.com', confirm: true } });
  assert.equal(e.status, 200);
  assert.equal(get("SELECT COUNT(*) AS n FROM outbox WHERE body_html LIKE '%maria.titular@cliente.com%' OR body_text LIKE '%Maria Titular%'").n, 0);
});

test('muitas notas baixas numa filial: casos abertos, mas os avisos param no teto e vai um aviso de pausa', async () => {
  run('DELETE FROM cases WHERE branch_id = ?', branchA);
  const before = get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'detractor' AND recipient = 'loja.a@empresa.com'").n;
  for (let i = 0; i < 13; i++) assert.equal((await kiosk({ answers: [{ questionId: q[0].id, value: 1 }] })).status, 201);
  assert.equal(get('SELECT COUNT(*) AS n FROM cases WHERE branch_id = ?', branchA).n, 13, 'todo detrator vira caso');
  assert.equal(get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'detractor' AND recipient = 'loja.a@empresa.com'").n - before, 10);
  assert.equal(get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'detractor_burst' AND recipient = 'loja.a@empresa.com'").n, 1);
});

test('canal de tempo real: no máximo 5 conexões por pessoa', async () => {
  const c = await login('adm@az.local');
  const ctrls = [];
  const open = async () => { const ctrl = new AbortController(); ctrls.push(ctrl); return fetch(base() + '/api/admin/events', { headers: { Cookie: c.cookie, 'X-Forwarded-For': c.ip }, signal: ctrl.signal }); };
  const st = [];
  for (let i = 0; i < 6; i++) st.push((await open()).status);
  ctrls.forEach((x) => x.abort());
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429]);
});

test('texto de cliente nas mensagens: uma linha, sem formatação e sem link clicável', () => {
  const evil = 'demorou_\n\n✅ *Caso já resolvido.*\nConfirme: https://evil.example/login';
  const t = customerText(evil);
  assert.ok(!t.includes('\n') && !t.includes('*') && !t.includes('https://evil.example'));
  const wa = whatsappFor('detractor', { filial: 'Loja', nota: '2', data_hora: 'x', canal: 'QR Code', comentario: evil, link_caso: 'https://painel/x' });
  assert.ok(!wa.includes('evil.example'));
  assert.ok(wa.includes('https://painel/x'), 'o link do sistema continua');
});

test('chamadas do servidor só para IPs públicos (inclusive formas alternativas do IPv6)', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::127.0.0.1', '::ffff:10.0.0.1', 'fe80::1', 'fec0::1', '64:ff9b::a00:1', '2002:a00:1::1', '2001::1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
});

test('fila do WhatsApp por QR Code tem teto: rajada não atrasa tudo por horas', () => {
  const qr = require('../src/whatsapp-qr');
  run("INSERT INTO settings (key, value) VALUES ('state.waQr', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ lastSlot: Date.now() + 3 * 3_600_000 }));
  assert.equal(qr.queue('5511999990000', 'teste', 'test'), null);
  assert.ok(get("SELECT 1 FROM outbox WHERE status = 'failed' AND last_error LIKE 'Fila do WhatsApp cheia%'"));
  run("UPDATE settings SET value = '{}' WHERE key = 'state.waQr'");
});
