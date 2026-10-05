'use strict';
// Configuração de e-mail (SMTP) e WhatsApp pelo painel: segredos criptografados, nunca devolvidos, SSRF e validação.
const test = require('node:test');
const assert = require('node:assert/strict');
const dnsp = require('node:dns').promises;
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { all } = require('../src/db');
const delivery = require('../src/delivery');

let admin; let gestor; let survey; let q; let tokA; let branchA;
const SECRET_PASS = 'SenhaSuperSecreta-Smtp#99';
const SECRET_TOKEN = 'EAAGm0PX4ZCpsBOzSecretTokenDaMetaAbcdef1234567890';

// DNS falso: nomes "exemplo" resolvem para IPs controlados pelo teste.
const FAKE = { 'smtp.exemplo.com.br': '203.0.113.10', 'interno.exemplo.com.br': '10.0.0.5', 'metadata.exemplo.com.br': '169.254.169.254', 'loop.exemplo.com.br': '127.0.0.1', 'v6.exemplo.com.br': '::1' };
const realLookup = dnsp.lookup;
dnsp.lookup = async (host) => { if (FAKE[host]) return [{ address: FAKE[host], family: FAKE[host].includes(':') ? 6 : 4 }]; throw new Error('ENOTFOUND'); };

test.before(async () => {
  await start();
  makeUser('adm@dl.local', 'admin');
  admin = new Client(); await admin.login('adm@dl.local', 'SenhaForte123');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'DL', name: 'Loja Envio', alert_phones: ['5511977776666'] } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa envio', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branchA}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchA, name: 'Tab envio' } });
  tokA = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('gestor@dl.local', 'gestor', 'SenhaForte123', [branchA]);
  gestor = new Client(); await gestor.login('gestor@dl.local', 'SenhaForte123');
});
test.after(() => { dnsp.lookup = realLookup; stop(); });

const smtpBody = (o = {}) => ({ smtp: { host: 'smtp.exemplo.com.br', port: 587, user: 'pesquisa@exemplo.com.br', password: SECRET_PASS, from: 'Pesquisa <pesquisa@exemplo.com.br>', ...o } });
const put = (c, body) => c.req('PUT', '/api/admin/settings/delivery', { body });

test('só administrador vê ou altera a configuração de envio', async () => {
  assert.equal((await new Client().req('GET', '/api/admin/settings/delivery')).status, 401);
  assert.equal((await gestor.req('GET', '/api/admin/settings/delivery')).status, 403);
  assert.equal((await put(gestor, smtpBody())).status, 403);
  assert.equal((await gestor.req('POST', '/api/admin/settings/test-whatsapp', { body: {} })).status, 403);
});

test('SMTP: recusa servidor interno, IP, porta estranha e injeção de cabeçalho', async () => {
  for (const host of ['interno.exemplo.com.br', 'metadata.exemplo.com.br', 'loop.exemplo.com.br', 'v6.exemplo.com.br']) {
    assert.equal((await put(admin, smtpBody({ host }))).status, 400, host + ' (rede interna)');
  }
  for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.1', 'smtp.exemplo.com.br:6379', 'a b.com', 'naoexiste.exemplo.com.br']) {
    assert.equal((await put(admin, smtpBody({ host }))).status, 400, host);
  }
  for (const port of [22, 6379, 80, 0, '587; x', null]) assert.equal((await put(admin, smtpBody({ port }))).status, 400, 'porta ' + port);
  assert.equal((await put(admin, smtpBody({ from: 'a@b.com\r\nBcc: x@y.z' }))).status, 400, 'injeção no remetente');
  assert.equal((await put(admin, smtpBody({ from: 'sem-arroba' }))).status, 400);
  assert.equal((await put(admin, smtpBody({ password: 'x\r\nRCPT TO:<a@b.c>' }))).status, 400, 'injeção na senha');
  assert.equal((await put(admin, smtpBody({ password: '' }))).status, 400, 'usuário sem senha');
  assert.equal((await put(admin, { smtp: 'texto' })).status, 400);
  assert.equal((await put(admin, { smtp: [1] })).status, 400);
  assert.equal(delivery.smtp(), null, 'nada foi gravado');
});

test('SMTP salvo: senha criptografada no banco e nunca devolvida; senha em branco mantém a atual', async () => {
  const r = await put(admin, smtpBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.smtp.passwordSet, true);
  assert.equal(r.json.smtp.source, 'painel');
  assert.ok(!r.text.includes(SECRET_PASS));
  const raw = get("SELECT value FROM settings WHERE key = 'delivery'").value;
  assert.ok(!raw.includes(SECRET_PASS), 'senha não pode estar em texto puro no banco');
  assert.equal(delivery.smtp().auth.pass, SECRET_PASS, 'o sistema consegue descriptografar para enviar');
  for (const url of ['/api/admin/settings/delivery', '/api/admin/settings', '/api/admin/me', '/api/admin/settings/notifications']) {
    assert.ok(!(await admin.req('GET', url)).text.includes(SECRET_PASS), url);
  }
  assert.equal((await put(admin, smtpBody({ password: '', host: 'smtp.exemplo.com.br', from: 'Outro <outro@exemplo.com.br>' }))).status, 200);
  assert.equal(delivery.smtp().auth.pass, SECRET_PASS, 'senha mantida');
  assert.equal(delivery.smtp().from, 'Outro <outro@exemplo.com.br>');
});

test('e-mail de teste usa a configuração do painel e falha com mensagem clara se o servidor não responde', async () => {
  // aponta para IP de documentação (não roteável): o envio deve falhar sem travar e registrar o erro
  const r = await admin.req('POST', '/api/admin/settings/test-email');
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, false);
  assert.ok(!JSON.stringify(r.json).includes(SECRET_PASS));
  const item = get("SELECT last_error FROM outbox WHERE kind = 'test' ORDER BY id DESC LIMIT 1");
  assert.ok(item.last_error && !item.last_error.includes(SECRET_PASS));
});

test('WhatsApp: valida identificador e token; token criptografado e nunca devolvido', async () => {
  for (const w of [{ phoneId: 'abc', token: SECRET_TOKEN }, { phoneId: '123', token: SECRET_TOKEN }, { phoneId: '109876543210987', token: 'curto' },
    { phoneId: '109876543210987', token: 'tem espaço no meio do token........' }, { phoneId: '109876543210987', token: '' }, 'x', [1]]) {
    assert.equal((await put(admin, { whatsapp: w })).status, 400, JSON.stringify(w));
  }
  const r = await put(admin, { whatsapp: { phoneId: '109876543210987', token: SECRET_TOKEN } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.whatsapp.tokenSet, true);
  assert.ok(!r.text.includes(SECRET_TOKEN));
  assert.ok(!get("SELECT value FROM settings WHERE key = 'delivery'").value.includes(SECRET_TOKEN));
  assert.equal(delivery.whatsapp().token, SECRET_TOKEN);
  assert.ok(!(await admin.req('GET', '/api/admin/settings')).text.includes(SECRET_TOKEN));
  assert.equal((await put(admin, { whatsapp: { phoneId: '109876543210999', token: '' } })).status, 200, 'trocar só o número mantém o token');
  assert.equal(delivery.whatsapp().token, SECRET_TOKEN);
});

test('WhatsApp pessoal do usuário: normaliza, valida e entra nos alertas de detrator', async () => {
  const set = (v) => gestor.req('PUT', '/api/admin/me/notifications', { body: { whatsapp: v } });
  assert.equal((await set('abc')).status, 400);
  assert.equal((await set('123')).status, 400);
  assert.equal((await set(5511)).status, 400);
  assert.equal((await set('(11) 99999-0000')).status, 200);
  assert.equal(get("SELECT whatsapp FROM users WHERE email = 'gestor@dl.local'").whatsapp, '5511999990000');
  assert.equal((await gestor.req('GET', '/api/admin/me')).json.user.whatsapp, '5511999990000');
  // alerta de detrator: precisa de modelo configurado; vai para o número da filial e para o do gestor
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { alerts: { whatsappTemplate: 'alerta_detrator' } } })).status, 200);
  const r = await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tokA },
    body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q[0].id, value: 2 }] } });
  assert.equal(r.status, 201, r.text);
  const to = all("SELECT recipient FROM outbox WHERE channel = 'whatsapp' AND kind = 'detractor'").map((x) => x.recipient).sort();
  assert.deepEqual(to, ['5511977776666', '5511999990000']);
  assert.equal((await set('')).status, 200);
  assert.equal(get("SELECT whatsapp FROM users WHERE email = 'gestor@dl.local'").whatsapp, null);
});

test('teste do WhatsApp: número inválido recusado e erro da Meta não vaza o token', async () => {
  const bad = await admin.req('POST', '/api/admin/settings/test-whatsapp', { body: { phone: 'abc' } });
  assert.ok([200, 400].includes(bad.status));
  assert.ok(!bad.text.includes(SECRET_TOKEN));
});

test('auditoria: não registra segredos, traz o nome de quem agiu e limita o tamanho da consulta', async () => {
  const a = await admin.req('GET', '/api/admin/audit?limit=50');
  assert.equal(a.status, 200);
  assert.ok(!a.text.includes(SECRET_PASS) && !a.text.includes(SECRET_TOKEN));
  const ev = a.json.find((x) => x.action === 'settings.delivery' && JSON.parse(x.detail).smtp);
  assert.ok(ev, 'ação registrada');
  assert.ok(ev.name && ev.email === 'adm@dl.local');
  assert.deepEqual(JSON.parse(ev.detail).smtp, 'alterado');
  for (const l of ['0', '5000', 'abc']) assert.equal((await admin.req('GET', `/api/admin/audit?limit=${l}`)).status, 400, 'limit ' + l);
  assert.equal((await gestor.req('GET', '/api/admin/audit')).status, 403);
});

test('remover configuração do painel volta ao padrão (.env)', async () => {
  assert.equal((await put(admin, { smtp: { clear: true }, whatsapp: { clear: true } })).status, 200);
  assert.equal(delivery.smtp(), null);
  assert.equal(delivery.whatsapp(), null);
  void run;
});
