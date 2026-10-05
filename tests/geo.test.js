'use strict';
// Localização das respostas pelo QR Code: autorização, validação, privacidade (arredondamento/retenção) e filtros.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { locate, fromClient } = require('../src/geo');
const { applyRetention } = require('../src/retention');

let admin; let gestor; let branch; let other; let survey; let q; let token; let devTok;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await start();
  makeUser('adm@g.local', 'admin');
  admin = new Client(); await admin.login('adm@g.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'GA', name: 'Loja Geo', city: 'Campinas' } })).json.id;
  other = (await admin.req('POST', '/api/admin/branches', { body: { code: 'GB', name: 'Loja Geo B' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa geo', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  for (const b of [branch, other]) await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  token = (await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true } })).json.url.split('/r/')[1];
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tablet geo' } });
  devTok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('gestor@g.local', 'gestor', 'SenhaForte123', [other]);
  gestor = new Client(); await gestor.login('gestor@g.local', 'SenhaForte123');
});
test.after(stop);

// O bilhete do link só vale depois de 3 s; para não esperar a cada teste, antecipamos a emissão no banco.
async function viaLink(score, geo, extra = {}) {
  const c = new Client();
  const cfg = (await c.req('GET', `/api/link/${token}/config`)).json;
  const [nonce, , sig] = cfg.ticket.split('.');
  const issued = Date.now() - 10_000;
  run('UPDATE link_tickets SET issued_at = ? WHERE nonce = ?', issued, nonce);
  const { sign } = require('../src/vault');
  const ticket = `${nonce}.${issued}.${sign(`${get('SELECT id FROM branches WHERE code = ?', 'GA').id}.${nonce}.${issued}`)}`;
  void sig;
  return c.req('POST', `/api/link/${token}/responses`, { body: { uuid: crypto.randomUUID(), surveyId: survey, ticket, answers: [{ questionId: q[0].id, value: score }], geo, ...extra } });
}

test('módulo geo: cidade/UF/região corretas, fora do Brasil e entradas inválidas', () => {
  assert.deepEqual(locate(-23.5614, -46.6559), { city: 'São Paulo', uf: 'SP', region: 'Sudeste', outside: false });
  assert.equal(locate(-3.119, -60.0217).uf, 'AM');
  assert.equal(locate(-5, -65).city, null, 'longe de qualquer sede: só estado');
  assert.equal(locate(38.72, -9.14).region, 'Fora do Brasil');
  for (const bad of [[NaN, 1], [Infinity, 1], [91, 0], [0, 181], ['1', 2], [null, null]]) assert.equal(locate(...bad), null);
  assert.ok(fromClient({ lat: -23.5, lng: -46.6 }).error, 'sem autorização');
  assert.ok(fromClient({ lat: -23.5, lng: -46.6, consent: 'true' }).error, 'autorização precisa ser booleana true');
  assert.ok(fromClient([1, 2]).error);
  assert.equal(fromClient({ lat: -23.56149, lng: -46.65591, consent: true }).lat, -23.56, 'arredonda para ~1 km');
});

test('QR com localização autorizada grava cidade/UF/região e coordenadas arredondadas', async () => {
  const r = await viaLink(9, { lat: -22.9056, lng: -47.0608, consent: true });
  assert.equal(r.status, 201, r.text);
  const row = get("SELECT geo_lat, geo_lng, geo_city, geo_uf, geo_region FROM responses WHERE channel = 'link' ORDER BY id DESC LIMIT 1");
  assert.deepEqual({ ...row }, { geo_lat: -22.91, geo_lng: -47.06, geo_city: 'Campinas', geo_uf: 'SP', geo_region: 'Sudeste' });
});

test('localização inválida ou sem autorização é recusada (e não consome a resposta indevidamente)', async () => {
  for (const geo of [{ lat: -22.9, lng: -47.0 }, { lat: -22.9, lng: -47.0, consent: false }, { lat: 'x', lng: 1, consent: true }, { lat: 500, lng: 1, consent: true }, 'texto', [1, 2], { lat: 1e999, lng: 1, consent: true }]) {
    assert.equal((await viaLink(8, geo)).status, 400, JSON.stringify(geo));
  }
  assert.equal(get("SELECT COUNT(*) AS n FROM responses WHERE channel = 'link'").n, 1);
});

test('sem localização o QR continua funcionando; tablet não aceita localização', async () => {
  assert.equal((await viaLink(7, undefined)).status, 201);
  assert.equal((await viaLink(10, null)).status, 201);
  const t = await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + devTok },
    body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q[0].id, value: 9 }], geo: { lat: -22.9, lng: -47.0, consent: true } } });
  assert.equal(t.status, 400);
});

test('lista, filtro por estado, estatísticas por região e CSV trazem o local', async () => {
  await viaLink(3, { lat: -19.92, lng: -43.94, consent: true }); // Belo Horizonte/MG
  await viaLink(9, { lat: 38.72, lng: -9.14, consent: true }); // fora do Brasil
  const all = (await admin.req('GET', '/api/admin/responses')).json.rows;
  const bh = all.find((x) => x.geo_city === 'Belo Horizonte');
  assert.equal(bh.geo_uf, 'MG'); assert.equal(bh.geo_region, 'Sudeste'); assert.equal(bh.branch_city, 'Campinas');
  assert.equal((await admin.req('GET', '/api/admin/responses?uf=MG')).json.total, 1);
  assert.equal((await admin.req('GET', '/api/admin/responses?uf=SP')).json.total, 1);
  assert.equal((await admin.req('GET', '/api/admin/responses?uf=_fora')).json.total, 1);
  assert.equal((await admin.req('GET', '/api/admin/responses?uf=_sem')).json.total, 2, 'QR sem localização');
  assert.equal((await admin.req('GET', '/api/admin/responses?uf=XX')).status, 400);
  assert.equal((await admin.req('GET', "/api/admin/responses?uf=SP'%20OR%201=1")).status, 400);
  const st = (await admin.req('GET', '/api/admin/stats')).json;
  assert.equal(st.linkNoGeo, 2);
  assert.ok(st.byRegion.find((r) => r.place === 'MG' && r.responses === 1));
  assert.ok(st.byCity.find((r) => r.city === 'Campinas' && r.uf === 'SP'));
  const csv = (await admin.req('GET', '/api/admin/responses.csv')).text;
  assert.match(csv, /Cidade \(cliente\)";"UF \(cliente\)";"Região \(cliente\)";"Latitude aprox\./);
  assert.match(csv, /"QR Code";"Belo Horizonte";"MG";"Sudeste";"-19,92";"-43,94"/);
  // gestor de outra filial não enxerga a região das respostas da filial A
  const g = (await gestor.req('GET', '/api/admin/stats')).json;
  assert.deepEqual(g.byRegion, []); assert.equal(g.linkNoGeo, 0);
  assert.equal((await gestor.req('GET', '/api/admin/responses')).json.total, 0);
});

test('privacidade: retenção apaga o ponto (mantém cidade/UF) e a anonimização também', async () => {
  const old = Date.now() - 400 * 86_400_000;
  run("UPDATE responses SET submitted_at = ? WHERE geo_uf = 'MG'", old);
  const r = applyRetention();
  assert.ok(r.coordinates >= 1);
  const row = get("SELECT geo_lat, geo_city, geo_uf FROM responses WHERE geo_uf = 'MG'");
  assert.equal(row.geo_lat, null); assert.equal(row.geo_city, 'Belo Horizonte');
  const { anonymize } = require('../src/routes/privacy');
  const id = get("SELECT id FROM responses WHERE geo_uf = 'SP' LIMIT 1").id;
  anonymize([id]);
  assert.equal(get('SELECT geo_lat FROM responses WHERE id = ?', id).geo_lat, null);
});

test('Permissions-Policy libera geolocalização só na página do QR (/r/…)', async () => {
  const c = new Client();
  assert.match((await c.req('GET', `/r/${token}`)).headers.get('permissions-policy'), /geolocation=\(self\)/);
  assert.match((await c.req('GET', '/admin/')).headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.match((await c.req('GET', '/kiosk/')).headers.get('permissions-policy'), /geolocation=\(\)/);
  void wait;
});
