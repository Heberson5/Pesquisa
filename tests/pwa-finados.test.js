'use strict';
// Painel instalável (manifesto, service worker, ícones) e pesquisas de Finados.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { start, stop, Client, makeUser, run, get, base } = require('./helpers');
const { all } = require('../src/db');
const { parseLocal } = require('../src/time');
const { effectiveSurveyId } = require('../src/responses');

const seed = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'seed-finados.js'), ...args], { encoding: 'utf8', env: process.env });
const at = (hm) => parseLocal(`2026-11-02T${hm}`, 'America/Cuiaba');
let branch; let admin;

test.before(async () => {
  await start();
  makeUser('adm@f.local', 'admin');
  admin = new Client(); await admin.login('adm@f.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'ATGS1', name: 'Atendimento TGS' } })).json.id;
});
test.after(stop);

test('manifesto do painel é válido e aponta para ícones que existem', async () => {
  const r = await fetch(base() + '/admin/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /manifest\+json/);
  const m = await r.json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/admin/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    const ic = await fetch(base() + i.src);
    assert.equal(ic.status, 200, i.src);
    assert.equal(ic.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await ic.arrayBuffer());
    assert.equal(b.readUInt32BE(16), Number(i.sizes.split('x')[0]), `largura real de ${i.src}`);
  }
});

test('service worker é JavaScript sem cache, tudo da lista dele existe e a API continua de fora', async () => {
  const r = await fetch(base() + '/admin/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const src = await r.text();
  assert.match(src, /startsWith\('\/api\/'\)\) return/);
  for (const f of JSON.parse(/SHELL = (\[.*?\])/.exec(src)[1].replace(/'/g, '"'))) assert.equal((await fetch(base() + f)).status, 200, f);
  const html = await (await fetch(base() + '/admin/')).text();
  for (const s of ['rel="manifest"', 'src="pwa.js"', 'viewport-fit=cover']) assert.ok(html.includes(s), s);
});

test('filial inexistente é recusada sem criar nenhuma pesquisa', () => {
  const r = seed('--branch=TGS');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /não encontrada/);
  assert.equal(get("SELECT COUNT(*) AS n FROM surveys WHERE title LIKE 'Finados 2026%'").n, 0);
});

test('cria 10 pesquisas de 2 perguntas de 0 a 10 e 10 agendamentos; repetir não duplica nem troca as perguntas', () => {
  const r = seed('--branch=ATGS1');
  assert.equal(r.status, 0, r.stderr);
  const surveys = all("SELECT id FROM surveys WHERE title LIKE 'Finados 2026%'");
  assert.equal(surveys.length, 10);
  for (const s of surveys) {
    const qs = all('SELECT type, is_nps, required FROM questions WHERE survey_id = ?', s.id);
    assert.equal(qs.length, 2);
    assert.ok(qs.every((q) => q.type === 'nps' && q.is_nps === 1 && q.required === 1));
  }
  assert.equal(get('SELECT COUNT(*) AS n FROM schedules WHERE branch_id = ?', branch).n, 10);
  const before = all('SELECT id FROM questions ORDER BY id').map((q) => q.id);
  const again = seed('--branch=ATGS1');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /criadas: 0; perguntas atualizadas: 0/);
  assert.match(again.stdout, /: 0\./);
  assert.equal(get("SELECT COUNT(*) AS n FROM surveys WHERE title LIKE 'Finados 2026%'").n, 10);
  assert.equal(get('SELECT COUNT(*) AS n FROM schedules').n, 10);
  assert.deepEqual(all('SELECT id FROM questions ORDER BY id').map((q) => q.id), before);
});

test('cada horário de Finados mostra a pesquisa certa e depois volta à padrão', () => {
  const b = get('SELECT * FROM branches WHERE id = ?', branch);
  const title = (hm) => { const id = effectiveSurveyId(b, at(hm)); return id ? get('SELECT title FROM surveys WHERE id = ?', id).title : null; };
  for (const [hm, rotulo, tipo] of [['06:45', '7h ', 'Antes'], ['06:59', '7h ', 'Antes'], ['08:00', '7h ', 'Depois'], ['08:29', '7h ', 'Depois'],
    ['08:45', '9h ', 'Antes'], ['10:00', '9h ', 'Depois'], ['10:15', '10h30 ', 'Antes'], ['11:30', '10h30 ', 'Depois'],
    ['14:15', '14h30 ', 'Antes'], ['15:30', '14h30 ', 'Depois'], ['15:45', '16h ', 'Antes'], ['17:00', '16h ', 'Depois'], ['17:29', '16h ', 'Depois']]) {
    const t = title(hm);
    assert.ok(t?.includes(`· ${rotulo}·`) && t.endsWith(tipo), `${hm}: ${t}`);
  }
  for (const hm of ['06:44', '07:00', '08:30', '09:00', '12:00', '14:00', '15:00', '16:00', '17:30']) assert.equal(title(hm), null, hm);
});

test('o cliente responde às 2 perguntas da pesquisa de Finados pelo tablet', async () => {
  const code = (await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tablet F' } })).json.code;
  const token = (await new Client().req('POST', '/api/kiosk/pair', { body: { code } })).json.token;
  const sv = get("SELECT id FROM surveys WHERE title LIKE 'Finados 2026 · 7h %Antes'");
  const qs = all('SELECT id FROM questions WHERE survey_id = ? ORDER BY position', sv.id);
  // Janela aberta agora, só para este teste.
  const sc = run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', sv.id, branch, Date.now() - 60_000, Date.now() + 60_000, Date.now()).lastInsertRowid;
  const cfg = await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(cfg.json.survey.id, sv.id);
  assert.equal(cfg.json.survey.questions.length, 2);
  const r = await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + token },
    body: { uuid: crypto.randomUUID(), surveyId: sv.id, answers: [{ questionId: qs[0].id, value: 10 }, { questionId: qs[1].id, value: 8 }] } });
  assert.equal(r.status, 201, r.text);
  run('DELETE FROM schedules WHERE id = ?', sc);
});
