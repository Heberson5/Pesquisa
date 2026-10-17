'use strict';
// Foto de perfil (tipo conferido pelo conteúdo, tamanho, acesso só logado) e prazos de guarda de até 10 anos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

let admin; let adminId; let gestor; let gestorId;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const put = (c, buf) => c.req('PUT', '/api/admin/me/photo', { raw: buf, headers: { 'Content-Type': 'application/octet-stream' } });

test.before(async () => {
  await start();
  adminId = makeUser('adm@f.local', 'admin');
  admin = new Client(); await admin.login('adm@f.local', 'SenhaForte123');
  gestorId = makeUser('ges@f.local', 'gestor');
  gestor = new Client(); await gestor.login('ges@f.local', 'SenhaForte123');
});
test.after(stop);

test('envia, mostra e remove a própria foto; SVG, HTML e arquivo grande são recusados', async () => {
  const r = await put(gestor, JPEG);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.photo_at);
  assert.equal((await gestor.req('GET', '/api/admin/me')).json.user.photo_at, r.json.photo_at);
  const img = await admin.req('GET', `/api/admin/users/${gestorId}/photo`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /private/);
  assert.equal((await put(gestor, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status, 415);
  assert.equal((await put(gestor, Buffer.from('<!doctype html><html><body>oi</body></html>'))).status, 415);
  assert.equal((await put(gestor, Buffer.concat([JPEG, Buffer.alloc(500 * 1024)]))).status, 413);
  assert.equal((await put(gestor, Buffer.alloc(0))).status, 400);
  assert.equal((await gestor.req('DELETE', '/api/admin/me/photo')).status, 200);
  assert.equal((await admin.req('GET', `/api/admin/users/${gestorId}/photo`)).status, 404);
});

test('foto só para quem está logado; ninguém troca a foto de outra pessoa', async () => {
  await put(admin, JPEG);
  assert.equal((await new Client().req('GET', `/api/admin/users/${adminId}/photo`)).status, 401);
  assert.equal((await new Client().req('PUT', '/api/admin/me/photo', { raw: JPEG, headers: { 'Content-Type': 'application/octet-stream' } })).status, 401);
  // Gestor não remove a foto do administrador (sem permissão de usuários).
  assert.equal((await gestor.req('DELETE', `/api/admin/users/${adminId}/photo`)).status, 403);
  assert.ok(get('SELECT 1 AS x FROM user_photos WHERE user_id = ?', adminId));
});

test('administrador remove foto inadequada; desativar o usuário apaga a foto', async () => {
  await put(gestor, JPEG);
  assert.equal((await admin.req('DELETE', `/api/admin/users/${gestorId}/photo`)).status, 200);
  assert.equal(get('SELECT COUNT(*) AS n FROM user_photos WHERE user_id = ?', gestorId).n, 0);
  await put(gestor, JPEG);
  const r = await admin.req('PUT', `/api/admin/users/${gestorId}`, { body: { name: 'Ges', email: 'ges@f.local', role: 'gestor', active: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal(get('SELECT COUNT(*) AS n FROM user_photos WHERE user_id = ?', gestorId).n, 0);
});

test('prazos de guarda aceitam até 10 anos (120 meses) e recusam mais', async () => {
  const ok = await admin.req('PUT', '/api/admin/settings', { body: { retention: { contactsMonths: 120, commentsMonths: 120, geoMonths: 24, auditMonths: 120 } } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.retention, { contactsMonths: 120, commentsMonths: 120, geoMonths: 24, auditMonths: 120 });
  for (const k of ['contactsMonths', 'commentsMonths', 'geoMonths', 'auditMonths']) {
    assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { retention: { [k]: 121 } } })).status, 400, k);
  }
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { retention: { auditMonths: 5 } } })).status, 400);
});

test('configuração antiga sem prazo da localização usa o prazo dos contatos', async () => {
  run("UPDATE settings SET value = ? WHERE key = 'retention'", JSON.stringify({ commentsMonths: 24, contactsMonths: 18, auditMonths: 24 }));
  const st = (await admin.req('GET', '/api/admin/settings')).json;
  assert.equal(st.retention.geoMonths, 18);
});

test('limpeza automática: 10 anos são 10 anos; a localização segue o prazo próprio', async () => {
  const { applyRetention } = require('../src/retention');
  run("UPDATE settings SET value = ? WHERE key = 'retention'", JSON.stringify({ commentsMonths: 120, contactsMonths: 120, geoMonths: 12, auditMonths: 120 }));
  const b = run("INSERT INTO branches (code, name, created_at) VALUES ('RT', 'Ret', ?)", Date.now()).lastInsertRowid;
  const s = run("INSERT INTO surveys (title, welcome_title, thanks_title, created_at, updated_at) VALUES ('R', 'R', 'R', ?, ?)", Date.now(), Date.now()).lastInsertRowid;
  const day = 86_400_000;
  const mk = (ageDays) => run(`INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, received_at, geo_lat, geo_lng, geo_city)
    VALUES (?,?,?,?,?, -23.5, -46.6, 'São Paulo')`, crypto.randomUUID(), s, b, Date.now() - ageDays * day, Date.now()).lastInsertRowid;
  const nineYears = mk(Math.round(9.95 * 365.25)); const twoYears = mk(2 * 365); const elevenYears = mk(11 * 365);
  const q = run("INSERT INTO questions (survey_id, position, text, type, required) VALUES (?, 0, 'Comentário', 'text', 0)", s).lastInsertRowid;
  for (const rid of [nineYears, elevenYears]) run('INSERT INTO answers (response_id, question_id, value_text) VALUES (?,?,?)', rid, q, 'Atendimento ótimo');
  applyRetention();
  const comment = (rid) => get('SELECT COUNT(*) AS n FROM answers WHERE response_id = ? AND question_id = ?', rid, q).n;
  assert.equal(comment(nineYears), 1, 'comentário com 9,95 anos continua guardado');
  assert.equal(comment(elevenYears), 0, 'comentário com mais de 10 anos é apagado');
  const geo = (rid) => get('SELECT geo_lat, geo_city FROM responses WHERE id = ?', rid);
  assert.equal(geo(twoYears).geo_lat, null, 'ponto apagado após 1 ano');
  assert.equal(geo(twoYears).geo_city, 'São Paulo', 'cidade mantida');
  assert.ok(get('SELECT 1 AS x FROM responses WHERE id = ?', nineYears), 'a resposta (nota) nunca é apagada');
});
