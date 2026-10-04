'use strict';
// Testes de ataque: contato com consentimento (LGPD), casos de detratores, alertas, webhook (SSRF) e retenção.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { validateWebhookUrl, isPublicIp } = require('../src/notify');

let admin; let gestorA; let branchA; let branchB; let survey; let q; let tokA; let tokB;
const kiosk = (tok, body) => new Client().req('POST', '/api/kiosk/responses', { body, headers: { Authorization: 'Bearer ' + tok } });
const answer = (nps, extra = {}) => ({ uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q[0].id, value: nps }, ...(extra.comment ? [{ questionId: q[1].id, value: extra.comment }] : [])], ...extra.body });

test.before(async () => {
  await start();
  makeUser('adm@c.local', 'admin');
  admin = new Client(); await admin.login('adm@c.local', 'SenhaForte123');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'CA', name: 'Casos A', alert_emails: ['loja.a@empresa.com'] } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'CB', name: 'Casos B' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa casos', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    contact_mode: 'detractors', questions: [{ text: 'Nota?', type: 'nps', is_nps: true }, { text: 'Comentário', type: 'text', required: false }] } })).json.id;
  for (const b of [branchA, branchB]) await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  const pair = async (b) => { const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Tab ' + b } }); return (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token; };
  tokA = await pair(branchA); tokB = await pair(branchB);
  makeUser('gestor.a@c.local', 'gestor', 'SenhaForte123', [branchA]);
  gestorA = new Client(); await gestorA.login('gestor.a@c.local', 'SenhaForte123');
});
test.after(stop);

test('contato: exige consentimento e só é aceito conforme o modo da pesquisa', async () => {
  const contact = { name: 'Maria', phone: '(11) 98888-7777', email: 'maria@cliente.com' };
  assert.equal((await kiosk(tokA, answer(3, { body: { contact } }))).status, 400, 'sem consentimento');
  assert.equal((await kiosk(tokA, answer(10, { body: { contact: { ...contact, consent: true } } }))).status, 400, 'modo detratores: promotor não pode');
  assert.equal((await kiosk(tokA, answer(3, { body: { contact: { name: 'X', consent: true } } }))).status, 400, 'sem telefone/e-mail');
  assert.equal((await kiosk(tokA, answer(3, { body: { contact: { phone: '123', consent: true } } }))).status, 400, 'telefone inválido');
  assert.equal((await kiosk(tokA, answer(3, { body: { contact: { email: 'a@b.c\r\nBcc: x@y.z', consent: true } } }))).status, 400, 'injeção de cabeçalho');
  assert.equal((await kiosk(tokA, answer(3, { body: { contact: 'texto' } }))).status, 400);
  const ok = await kiosk(tokA, answer(2, { comment: 'Fila enorme', body: { contact: { ...contact, consent: true } } }));
  assert.equal(ok.status, 201, ok.text);
});

test('contato fica criptografado no banco (nem nome, nem telefone, nem e-mail em texto puro)', async () => {
  const r = get('SELECT * FROM responses WHERE contact_consent_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  const dump = JSON.stringify(r);
  assert.doesNotMatch(dump, /Maria|98888|maria@cliente/);
  assert.match(r.contact_phone_enc, /^v1\./);
});

test('detrator abre caso e enfileira alerta para a filial; promotor não', async () => {
  const before = get('SELECT COUNT(*) AS n FROM cases').n;
  await kiosk(tokA, answer(9));
  assert.equal(get('SELECT COUNT(*) AS n FROM cases').n, before);
  await kiosk(tokA, answer(0, { comment: '<script>alert(1)</script>' }));
  assert.equal(get('SELECT COUNT(*) AS n FROM cases').n, before + 1);
  const mail = get("SELECT * FROM outbox WHERE kind = 'detractor' AND recipient = 'loja.a@empresa.com' ORDER BY id DESC LIMIT 1");
  assert.ok(mail, 'e-mail para a lista da filial');
  assert.doesNotMatch(mail.body_html, /<script>/, 'comentário escapado no HTML do e-mail');
  assert.match(mail.body_html, /&lt;script&gt;/);
});

test('gestor só vê e altera casos das próprias filiais', async () => {
  await kiosk(tokB, answer(1));
  const caseB = get('SELECT id FROM cases WHERE branch_id = ? ORDER BY id DESC LIMIT 1', branchB).id;
  const list = await gestorA.req('GET', '/api/admin/cases');
  assert.ok(list.json.rows.length > 0);
  assert.ok(list.json.rows.every((r) => r.branch === 'Casos A'));
  assert.equal((await gestorA.req('GET', `/api/admin/cases/${caseB}`)).status, 404);
  assert.equal((await gestorA.req('PUT', `/api/admin/cases/${caseB}`, { body: { status: 'resolvido' } })).status, 404);
  assert.equal((await gestorA.req('GET', `/api/admin/cases?branchId=${branchB}`)).status, 404);
  assert.equal(get('SELECT status FROM cases WHERE id = ?', caseB).status, 'aberto');
});

test('caso: status/responsável validados, histórico registrado e acesso ao contato auditado', async () => {
  const c = get('SELECT c.id FROM cases c JOIN responses r ON r.id = c.response_id WHERE r.contact_consent_at IS NOT NULL LIMIT 1');
  const detail = await gestorA.req('GET', `/api/admin/cases/${c.id}`);
  assert.equal(detail.json.contact.name, 'Maria');
  assert.ok(get("SELECT 1 FROM audit_log WHERE action = 'contact.view'"));
  assert.equal((await gestorA.req('PUT', `/api/admin/cases/${c.id}`, { body: { status: 'fechado_hack' } })).status, 400);
  const outsider = makeUser('outro@c.local', 'gestor', 'SenhaForte123', [branchB]);
  assert.equal((await gestorA.req('PUT', `/api/admin/cases/${c.id}`, { body: { assigneeId: outsider } })).status, 400, 'responsável sem acesso à filial');
  const ok = await gestorA.req('PUT', `/api/admin/cases/${c.id}`, { body: { status: 'resolvido', note: 'Liguei e resolvi <b>ok</b>' } });
  assert.equal(ok.status, 200, ok.text);
  const after = (await gestorA.req('GET', `/api/admin/cases/${c.id}`)).json;
  assert.equal(after.status, 'resolvido'); assert.ok(after.resolved_at);
  assert.equal(after.notes.at(-1).text, 'Liguei e resolvi <b>ok</b>');
  assert.equal((await gestorA.req('GET', '/api/admin/cases/summary')).json.resolvidos >= 1, true);
});

test('LGPD: só admin acessa pedidos do titular; busca por telefone em qualquer formato; exclusão anonimiza', async () => {
  assert.equal((await gestorA.req('POST', '/api/admin/privacy/search', { body: { phone: '11988887777' } })).status, 403);
  assert.equal((await new Client().req('POST', '/api/admin/privacy/search', { body: { phone: '11988887777' } })).status, 401);
  const s = await admin.req('POST', '/api/admin/privacy/search', { body: { phone: '+55 (11) 98888-7777' } });
  assert.equal(s.status, 200); assert.equal(s.json.length, 1); assert.equal(s.json[0].name, 'Maria');
  const ex = await admin.req('POST', '/api/admin/privacy/export', { body: { email: 'MARIA@cliente.com' } });
  assert.equal(ex.json.registros[0].contato.telefone, '11988887777');
  assert.equal((await admin.req('POST', '/api/admin/privacy/erase', { body: { email: 'maria@cliente.com' } })).status, 400, 'exige confirmação');
  const er = await admin.req('POST', '/api/admin/privacy/erase', { body: { email: 'maria@cliente.com', confirm: true } });
  assert.equal(er.json.erased, 1);
  assert.equal((await admin.req('POST', '/api/admin/privacy/search', { body: { phone: '11988887777' } })).json.length, 0);
  const r = get('SELECT * FROM responses WHERE anonymized_at IS NOT NULL LIMIT 1');
  assert.equal(r.contact_name_enc, null);
  assert.equal(get("SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'text' AND a.response_id = ?", r.id).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM answers WHERE response_id = ?', r.id).n, 1, 'nota numérica preservada para o NPS');
});

test('retenção automática apaga contatos e comentários vencidos', async () => {
  await kiosk(tokA, answer(4, { body: { contact: { phone: '11977776666', consent: true } } }));
  const withContact = get('SELECT id FROM responses ORDER BY id DESC LIMIT 1').id;
  await kiosk(tokA, answer(8, { comment: 'comentário antigo' }));
  const withComment = get('SELECT id FROM responses ORDER BY id DESC LIMIT 1').id;
  run('UPDATE responses SET submitted_at = ? WHERE id IN (?, ?)', Date.now() - 800 * 86_400_000, withContact, withComment);
  const res = require('../src/retention').applyRetention();
  assert.ok(res.contacts >= 1, 'contato vencido'); assert.ok(res.comments >= 1, 'comentário vencido');
  assert.equal(get('SELECT contact_phone_enc FROM responses WHERE id = ?', withContact).contact_phone_enc, null);
  assert.equal(get("SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.type = 'text' AND a.response_id = ?", withComment).n, 0);
});

test('webhook: bloqueia http, IPs, endereços internos e credenciais na URL (SSRF)', async () => {
  for (const url of ['http://exemplo.com/h', 'https://127.0.0.1/h', 'https://[::1]/h', 'https://169.254.169.254/latest', 'https://localhost/h',
    'https://intranet.local/h', 'https://user:pass@exemplo.com/h', 'https://exemplo.com:8443/h', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.ok(validateWebhookUrl(url), url);
    assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: url } } })).status, 400, url);
  }
  for (const ip of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: 'https://hooks.exemplo.com/nps' } } })).status, 200);
  assert.equal((await gestorA.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: 'https://hooks.exemplo.com/x' } } })).status, 403);
});

test('webhook: domínio que resolve para IP interno é bloqueado na hora do envio (DNS rebinding)', async () => {
  const { safeLookup } = require('../src/notify');
  const err = await new Promise((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
  assert.ok(err, 'localhost deve ser bloqueado');
});

test('filial: e-mails e telefones de alerta validados (sem injeção)', async () => {
  for (const body of [{ alert_emails: ['a@b.com\r\nBcc: x@y.com'] }, { alert_emails: 'a@b.com' }, { alert_phones: ['11999990000'] }, { alert_phones: ['abc'] },
    { nps_goal: 500 }, { hours: [null] }, { hours: Array(7).fill({ open: '18:00', close: '08:00' }) }, { hours: Array(7).fill({ open: '8h', close: '18h' }) }]) {
    const r = await admin.req('PUT', `/api/admin/branches/${branchA}`, { body: { code: 'CA', name: 'Casos A', ...body } });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const ok = await admin.req('PUT', `/api/admin/branches/${branchA}`, { body: { code: 'CA', name: 'Casos A', alert_emails: ['loja.a@empresa.com'],
    alert_phones: ['+55 11 99999-0000'], nps_goal: 60, hours: [null, ...Array(6).fill({ open: '08:00', close: '20:00' })] } });
  assert.equal(ok.status, 200, ok.text);
});
