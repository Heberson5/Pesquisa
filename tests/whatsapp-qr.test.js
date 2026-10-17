'use strict';
// WhatsApp por QR Code: fila com pausa sorteada de 15 a 60 s, um envio por vez, espera na desconexão,
// permissões e configuração. A conexão com o WhatsApp é trocada por um envio simulado (só a fila é testada aqui).
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const wa = require('../src/whatsapp-qr');
const { all } = require('../src/db');

let admin; let gestor; let branch; let survey; let qNps; let tok;
const sent = [];
const fake = { send: async (phone, text) => { if (phone === '5511900000999') throw new Error('Este número não tem WhatsApp.'); sent.push({ phone, text, at: Date.now() }); } };
const qrItems = () => all(`SELECT * FROM outbox WHERE channel = 'whatsapp' AND payload LIKE '%"mode":"qr"%' ORDER BY next_attempt_at, id`);
const resetQueue = () => { run("DELETE FROM outbox WHERE channel = 'whatsapp'"); run("DELETE FROM settings WHERE key = 'state.waQr'"); sent.length = 0; };

test.before(async () => {
  await start();
  const adminId = makeUser('adm@w.local', 'admin');
  run("UPDATE users SET whatsapp = '5511911111111', name = 'Carlos' WHERE id = ?", adminId);
  admin = new Client(); await admin.login('adm@w.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'WQ', name: 'Loja Zap', alert_phones: ['5511922222222', '5511933333333', '5511911111111'] } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Zap', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: survey } });
  qNps = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions[0].id;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab Z' } });
  tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('ges@w.local', 'gestor', 'SenhaForte123', [branch]);
  gestor = new Client(); await gestor.login('ges@w.local', 'SenhaForte123');
});
test.after(() => { wa.useTransportForTests(null); wa.stopWorker(); stop(); });

const detractor = () => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
  body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: qNps, value: 1 }] } });

test('configuração: só QR, Meta ou desligado; intervalo entre 15 e 60 s, mínimo ≤ máximo', async () => {
  const put = (whatsapp) => admin.req('PUT', '/api/admin/settings', { body: { whatsapp } });
  assert.equal((await put({ minDelaySec: 14 })).status, 400);
  assert.equal((await put({ maxDelaySec: 61 })).status, 400);
  assert.equal((await put({ minDelaySec: 50, maxDelaySec: 20 })).status, 400);
  assert.equal((await put({ mode: 'pirata' })).status, 400);
  const ok = await put({ mode: 'qr', minDelaySec: 15, maxDelaySec: 60 });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.whatsapp, { mode: 'qr', minDelaySec: 15, maxDelaySec: 60 });
});

test('permissões: gestor não vê; QR Code só para quem pode conectar', async () => {
  assert.equal((await gestor.req('GET', '/api/admin/whatsapp-qr')).status, 403);
  assert.equal((await gestor.req('POST', '/api/admin/whatsapp-qr/connect')).status, 403);
  assert.equal((await gestor.req('PUT', '/api/admin/settings', { body: { whatsapp: { mode: 'off' } } })).status, 403);
  const role = (await admin.req('POST', '/api/admin/roles', { body: { name: 'Vê envios', scope: 'all', perms: ['cfg_envios.ver'] } })).json.id;
  await admin.req('POST', '/api/admin/users', { body: { name: 'Leitor', email: 'leitor@w.local', password: 'SenhaForte123', roleId: role } });
  const c = new Client(); await c.login('leitor@w.local', 'SenhaForte123');
  const st = await c.req('GET', '/api/admin/whatsapp-qr');
  assert.equal(st.status, 200);
  assert.equal(st.json.qr, null);
  assert.equal((await c.req('POST', '/api/admin/whatsapp-qr/disconnect')).status, 403);
});

test('alerta para vários destinatários: um número repetido recebe uma vez; pausa de 15 a 60 s entre cada um', async () => {
  resetQueue();
  wa.useTransportForTests(fake);
  const t0 = Date.now();
  assert.equal((await detractor()).status, 201);
  const items = qrItems();
  assert.deepEqual(items.map((i) => i.recipient).sort(), ['5511911111111', '5511922222222', '5511933333333']);
  assert.ok(items[0].next_attempt_at - t0 < 2000, 'o primeiro sai na hora');
  for (let i = 1; i < items.length; i++) {
    const gap = items[i].next_attempt_at - items[i - 1].next_attempt_at;
    assert.ok(gap >= 15_000 && gap <= 60_000, `pausa de ${gap} ms`);
  }
  const first = JSON.parse(items.find((i) => i.recipient === '5511911111111').payload);
  assert.match(first.text, /Olá, Carlos/, 'o texto do modelo leva o nome de quem recebe');
  assert.match(first.text, /Loja Zap/);
  // A fila geral (e-mails, Meta) não mexe nesta fila.
  await require('../src/notify').processOutbox();
  assert.equal(qrItems().filter((i) => i.status === 'sent').length, 0);
});

test('envia um por vez, só no horário; nunca dois seguidos antes do mínimo', async () => {
  const items = qrItems();
  assert.equal(await wa.processQueue(items[0].next_attempt_at), 1);
  assert.equal(await wa.processQueue(items[0].next_attempt_at + 1000), 0, 'o segundo ainda não chegou na hora');
  // Servidor parado por 10 minutos: os dois restantes estão vencidos, mas só um sai.
  const later = items[0].next_attempt_at + 600_000;
  assert.equal(await wa.processQueue(later), 1);
  assert.equal(await wa.processQueue(later + 2000), 0, 'respeita a pausa mínima depois de um envio');
  const rest = qrItems().find((i) => i.status === 'pending');
  assert.ok(rest.next_attempt_at - later >= 15_000 && rest.next_attempt_at - later <= 60_000, 'reagendado com nova pausa');
  assert.equal(await wa.processQueue(rest.next_attempt_at), 1);
  assert.equal(sent.length, 3);
});

test('desconectado: a mensagem espera (sem gastar tentativa) e desiste depois de 24 horas', async () => {
  resetQueue();
  wa.useTransportForTests(null);
  const at = wa.queue('5511944444444', 'oi', 'test');
  assert.equal(await wa.processQueue(at), 0);
  let item = qrItems()[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.attempts, 0);
  assert.match(item.last_error, /reconectar/);
  run('UPDATE outbox SET created_at = ?, next_attempt_at = ? WHERE id = ?', Date.now() - 25 * 3_600_000, Date.now(), item.id);
  await wa.processQueue(Date.now());
  item = qrItems()[0];
  assert.equal(item.status, 'failed');
});

test('número sem WhatsApp falha na hora; envio de teste do modelo vai para o WhatsApp de Minha conta', async () => {
  resetQueue();
  wa.useTransportForTests(fake);
  const at = wa.queue('5511900000999', 'oi', 'test');
  await wa.processQueue(at);
  assert.equal(qrItems()[0].status, 'failed');
  const r = await admin.req('POST', '/api/admin/templates/detractor/whatsapp/test');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.to, '5511911111111');
  const test1 = qrItems().find((i) => i.kind === 'test' && i.recipient === '5511911111111');
  assert.match(JSON.parse(test1.payload).text, /^\[Teste\] .*Cliente insatisfeito/s);
  const st = (await admin.req('GET', '/api/admin/whatsapp-qr')).json;
  assert.equal(st.state, 'connected');
  assert.ok(st.queue.some((q) => q.kind === 'test' && q.to === 'Carlos' && q.status === 'pending'), 'a fila da tela mostra o nome de quem recebe');
});

test('modo Meta continua como antes: sem texto livre, só o modelo aprovado', async () => {
  resetQueue();
  await admin.req('PUT', '/api/admin/settings', { body: { whatsapp: { mode: 'meta' }, alerts: { whatsappTemplate: 'alerta_detrator' } } });
  await detractor();
  const items = all("SELECT payload FROM outbox WHERE channel = 'whatsapp'");
  assert.ok(items.length >= 3);
  assert.ok(items.every((i) => JSON.parse(i.payload).template === 'alerta_detrator'));
  assert.equal((await admin.req('POST', '/api/admin/templates/detractor/whatsapp/test')).status, 400);
});
