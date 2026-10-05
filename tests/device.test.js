'use strict';
// Nome do dispositivo nas respostas: tablet = nome cadastrado (fica gravado mesmo se renomear/remover); QR = aparelho/navegador.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run } = require('./helpers');
const { deviceLabel } = require('../src/ua');
const { sign } = require('../src/vault');

let admin; let branch; let survey; let q; let token; let tabId; let tabTok;

test.before(async () => {
  await start();
  makeUser('adm@dv.local', 'admin');
  admin = new Client(); await admin.login('adm@dv.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'DV', name: 'Loja Disp', city: 'Santos' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa disp', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  token = (await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true } })).json.url.split('/r/')[1];
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tablet recepção' } });
  tabId = d.json.id;
  tabTok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
});
test.after(stop);

async function viaLink(ua) {
  const c = new Client();
  const cfg = (await c.req('GET', `/api/link/${token}/config`)).json;
  const [nonce] = cfg.ticket.split('.');
  const issued = Date.now() - 10_000;
  run('UPDATE link_tickets SET issued_at = ? WHERE nonce = ?', issued, nonce);
  const ticket = `${nonce}.${issued}.${sign(`${branch}.${nonce}.${issued}`)}`;
  return c.req('POST', `/api/link/${token}/responses`, { headers: ua ? { 'User-Agent': ua } : {}, body: { uuid: crypto.randomUUID(), surveyId: survey, ticket, answers: [{ questionId: q[0].id, value: 9 }] } });
}
const tablet = () => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tabTok }, body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q[0].id, value: 10 }] } });

test('rótulo do aparelho: genérico, sem guardar o User-Agent', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'), 'Android (celular) · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'), 'Android (tablet) · Chrome');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0'), 'iPhone · Instagram');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0'), 'Windows · Edge');
  assert.equal(deviceLabel(undefined), 'Aparelho não identificado');
  assert.equal(deviceLabel('x'.repeat(5000)), 'Aparelho desconhecido');
  assert.ok(!deviceLabel('<script>alert(1)</script> iPhone').includes('<'));
});

test('QR grava o tipo de aparelho; tablet grava o nome cadastrado e ele sobrevive a renomear/remover', async () => {
  assert.equal((await viaLink('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1')).status, 201);
  assert.equal((await tablet()).status, 201);
  const rows = (await admin.req('GET', '/api/admin/responses')).json.rows;
  const qr = rows.find((x) => x.channel === 'link'); const tb = rows.find((x) => x.channel === 'tablet');
  assert.equal(qr.device_label, 'iPhone · Safari');
  assert.equal(tb.device_label, 'Tablet recepção');
  assert.equal(tb.branch_city, 'Santos');
  run('UPDATE devices SET name = ? WHERE id = ?', 'Nome novo', tabId);
  assert.equal((await admin.req('GET', '/api/admin/responses')).json.rows.find((x) => x.channel === 'tablet').device_label, 'Tablet recepção', 'histórico não muda');
  run('DELETE FROM devices WHERE id = ?', tabId);
  assert.equal((await admin.req('GET', '/api/admin/responses')).json.rows.find((x) => x.channel === 'tablet').device_label, 'Tablet recepção', 'continua após remover o tablet');
});

test('QR sem User-Agent não quebra e o CSV traz dispositivo e cidade da loja', async () => {
  assert.equal((await viaLink('')).status, 201);
  const csv = (await admin.req('GET', '/api/admin/responses.csv')).text;
  assert.match(csv, /"Dispositivo";"Canal";"Cidade da loja"/);
  assert.match(csv, /"iPhone · Safari";"QR Code";"Santos"/);
  assert.match(csv, /"Tablet recepção";"Tablet";"Santos"/);
});
