'use strict';
// Modelos de mensagem: edição com validação, uso no envio real, proteção contra HTML/variáveis do cliente e prévia isolada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, get } = require('./helpers');

let admin; let gestor; let branch; let survey; let qNps; let qText; let tok;

test.before(async () => {
  await start();
  makeUser('adm@m.local', 'admin');
  admin = new Client(); await admin.login('adm@m.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'MM', name: 'Loja Modelo', alert_emails: ['loja@m.local'] } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Modelo', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }, { text: 'Comente', type: 'text', required: false }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: survey } });
  const qs = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions; qNps = qs[0].id; qText = qs[1].id;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab M' } });
  tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('ges@m.local', 'gestor', 'SenhaForte123', [branch]);
  gestor = new Client(); await gestor.login('ges@m.local', 'SenhaForte123');
});
test.after(stop);

const respond = (nps, comment) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
  body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: qNps, value: nps }, { questionId: qText, value: comment }] } });

test('lista os tipos com variáveis e textos padrão; gestor sem permissão não acessa', async () => {
  const r = await admin.req('GET', '/api/admin/templates');
  assert.equal(r.status, 200);
  const det = r.json.find((k) => k.key === 'detractor');
  assert.deepEqual(det.channels, ['email', 'whatsapp']);
  assert.ok(det.vars.some((v) => v.key === 'link_caso'));
  assert.equal(det.templates.email.custom, false);
  assert.equal((await gestor.req('GET', '/api/admin/templates')).status, 403);
  assert.equal((await gestor.req('PUT', '/api/admin/templates/detractor/email', { body: { subject: 'x', title: 'y' } })).status, 403);
});

test('recusa variável inexistente, campo obrigatório vazio, canal que não existe e texto longo demais', async () => {
  const bad = (kind, ch, body) => admin.req('PUT', `/api/admin/templates/${kind}/${ch}`, { body });
  const r = await bad('detractor', 'email', { subject: 'Nota {nota}', title: 'Olá {senha_admin}' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /senha_admin/);
  assert.equal((await bad('detractor', 'email', { subject: '', title: 'x' })).status, 400);
  assert.equal((await bad('reset', 'whatsapp', { text: 'oi' })).status, 404);
  assert.equal((await bad('nada', 'email', { subject: 'a', title: 'b' })).status, 404);
  assert.equal((await bad('test', 'whatsapp', { text: 'a'.repeat(2001) })).status, 400);
});

test('o texto salvo vale no envio real; comentário do cliente não vira HTML nem variável', async () => {
  const r = await admin.req('PUT', '/api/admin/templates/detractor/email', { body: {
    subject: 'URGENTE {filial}\r\nBcc: invasor@x.com — nota {nota}', title: 'Atenção, {destinatario}', intro: 'Comentário: {comentario}\nLink: {link_caso}', button: 'Ver agora', footer: 'Equipe {empresa}' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.custom, true);
  assert.doesNotMatch(r.json.subject, /[\r\n]/, 'assunto sem quebra de linha (injeção de cabeçalho)');
  const sent = await respond(2, '<script>alert(1)</script> {nota} <a href="https://golpe.com">clique</a>');
  assert.equal(sent.status, 201, sent.text);
  const mail = get("SELECT * FROM outbox WHERE kind = 'detractor' AND recipient = 'loja@m.local' ORDER BY id DESC LIMIT 1");
  assert.match(mail.subject, /^URGENTE Loja Modelo Bcc: invasor@x\.com — nota 2$/);
  assert.match(mail.body_html, /Atenção, equipe/);
  assert.match(mail.body_html, /&lt;script&gt;/);
  assert.doesNotMatch(mail.body_html, /<script>|<a href="https:\/\/golpe/);
  assert.match(mail.body_text, /Comentário: <script>alert\(1\)<\/script> \{nota\}/, 'o {nota} digitado pelo cliente fica como texto');
  // Usuário cadastrado recebe com o próprio nome.
  const adm = get("SELECT * FROM outbox WHERE kind = 'detractor' AND recipient = 'adm@m.local' ORDER BY id DESC LIMIT 1");
  assert.match(adm.body_html, /Atenção, adm@m\.local/);
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'template.update'"));
});

test('restaurar volta ao texto padrão', async () => {
  const r = await admin.req('DELETE', '/api/admin/templates/detractor/email');
  assert.equal(r.status, 200);
  assert.equal(r.json.custom, false);
  assert.equal(r.json.subject, '[Alerta] Nota {nota} em {filial}');
});

test('prévia: WhatsApp em texto; e-mail aberto só por quem pediu, em página isolada e sem scripts', async () => {
  const wa = await admin.req('POST', '/api/admin/templates/detractor/whatsapp/preview', { body: { text: '*{filial}* nota {nota}\n{cliente}' } });
  assert.equal(wa.status, 200, wa.text);
  assert.equal(wa.json.text, '*Loja Centro · Campinas* nota 3\nMariana S.');
  const em = await admin.req('POST', '/api/admin/templates/offline/email/preview', { body: { subject: 'Sem sinal: {tablet}', title: 'Olá', intro: 'x', button: '', footer: '' } });
  assert.equal(em.json.subject, 'Sem sinal: Tablet do caixa 2');
  const page = await admin.req('GET', em.json.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.text, /Tablet do caixa 2/);
  const other = new Client(); makeUser('adm2@m.local', 'admin'); await other.login('adm2@m.local', 'SenhaForte123');
  assert.equal((await other.req('GET', em.json.url)).status, 404, 'prévia de outra pessoa');
  assert.equal((await new Client().req('GET', em.json.url)).status, 401);
  assert.equal((await admin.req('POST', '/api/admin/templates/offline/email/preview', { body: { subject: '{xyz}', title: 'a' } })).status, 400);
});

test('redefinição de senha também usa o modelo editado', async () => {
  await admin.req('PUT', '/api/admin/templates/reset/email', { body: { subject: 'Nova senha — {empresa}', title: 'Oi {destinatario}', intro: 'Use o link.', button: 'Trocar senha', footer: '' } });
  await new Client().req('POST', '/api/admin/password/forgot', { body: { email: 'ges@m.local' } });
  const mail = get("SELECT * FROM outbox WHERE kind = 'password_reset' AND recipient = 'ges@m.local' ORDER BY id DESC LIMIT 1");
  assert.match(mail.subject, /^Nova senha — /);
  assert.match(mail.body_text, /Oi ges@m\.local/);
  assert.match(mail.body_text, /Trocar senha: http.*\/admin\/#\/redefinir\//);
});
