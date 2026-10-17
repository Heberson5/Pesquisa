'use strict';
// Testes de ataque na parte pública (QR Code e tablet): bilhete não se perde com dado digitado errado, assinatura
// malformada não derruba a requisição, cliente não dispensa perguntas obrigatórias, limites por bloco IPv6 e
// com teto de memória, e caracteres que corromperiam o PowerPoint são removidos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, get } = require('./helpers');
const { sign } = require('../src/vault');
const { clientKey, rateLimiter } = require('../src/security');
const { str } = require('../src/validate');

let admin; let branch; let survey; let q; let token;
const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };

test.before(async () => {
  await start();
  makeUser('adm@ph.local', 'admin');
  admin = new Client(); await admin.login('adm@ph.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'PH', name: 'Loja Pública' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Pública', contact_mode: 'always',
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }, { text: 'Por quê?', type: 'text' }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  token = (await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true } })).json.url.split('/r/')[1];
});
test.after(stop);

// Bilhete emitido "há 10 s" (o mínimo é 3 s), assinado como o servidor faz.
const ticket = (issued = Date.now() - 10_000, nonce = crypto.randomUUID().replace(/-/g, '')) => `${nonce}.${issued}.${sign(`${branch}.${nonce}.${issued}`)}`;
const send = (c, body) => c.req('POST', `/api/link/${token}/responses`, { body: { uuid: crypto.randomUUID(), surveyId: survey, ...body } });
const full = [{ questionId: 0, value: 3 }, { questionId: 1, value: 'Fila' }];
const answers = () => full.map((a) => ({ ...a, questionId: q[a.questionId].id }));

test('e-mail digitado errado não queima o bilhete: o cliente corrige e envia', async () => {
  const c = new Client(); const t = ticket();
  const bad = await send(c, { ticket: t, answers: answers(), contact: { email: 'maria@gmail', consent: true } });
  assert.equal(bad.status, 400);
  const ok = await send(c, { ticket: t, answers: answers(), contact: { email: 'maria@gmail.com', consent: true } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal((await send(c, { ticket: t, answers: answers() })).status, 409, 'depois de usado, não vale de novo');
});

test('assinatura com caracteres não ASCII é recusada com 400 (não 500)', async () => {
  const [n, iss] = ticket().split('.');
  const r = await send(new Client(), { ticket: `${n}.${iss}.é${'A'.repeat(42)}`, answers: answers() });
  assert.equal(r.status, 400);
});

test('no QR Code, informar uma "versão antiga" não dispensa as perguntas obrigatórias', async () => {
  // Bilhete emitido depois da última alteração da pesquisa (como acontece de verdade).
  const issued = get('SELECT updated_at FROM surveys WHERE id = ?', survey).updated_at + 1;
  while (Date.now() - issued < 3_100) await new Promise((r) => setTimeout(r, 100));
  const r = await send(new Client(), { ticket: ticket(issued), surveyVersion: 1, answers: [{ questionId: q[0].id, value: 9 }] });
  assert.equal(r.status, 400);
});

test('código de link inválido é recusado antes dos limites (não ocupa memória)', async () => {
  const r = await new Client().req('GET', `/api/link/${'x'.repeat(5000)}/config`);
  assert.equal(r.status, 404);
});

test('limites contam o bloco IPv6 /64 e o IPv4 mapeado', () => {
  assert.equal(clientKey({ ip: '2001:db8:1:2::5' }), clientKey({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
  assert.notEqual(clientKey({ ip: '2001:db8:1:2::5' }), clientKey({ ip: '2001:db8:1:3::5' }));
  assert.equal(clientKey({ ip: '::ffff:10.0.0.1' }), '10.0.0.1');
  assert.equal(clientKey({ ip: '10.0.0.1' }), '10.0.0.1');
});

test('limitador tem teto de chaves: muitos endereços diferentes não esgotam a memória', () => {
  const l = rateLimiter({ windowMs: 60_000, max: 5 });
  let refused = 0;
  for (let i = 0; i < 50_010; i++) if (!l.hit('k' + i).ok) refused++;
  assert.equal(refused, 10);
  l.reset();
});

test('caracteres inválidos em XML são removidos dos textos', () => {
  assert.equal(str('a￿b￾c\uD800d', { field: 'x', max: 50 }), 'abcd');
});

test('a pesquisa enviada ao tablet indica quais perguntas contam no NPS', async () => {
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab' } });
  const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  const cfg = (await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok } })).json;
  assert.deepEqual(cfg.survey.questions.map((x) => x.isNps), [true, false]);
});
