'use strict';
// NPS na escala de 0 a 100: fórmula, cores/metas, validação e conversão única das metas gravadas na escala antiga.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { start, stop, Client, makeUser } = require('./helpers');
const { npsFromCounts } = require('../src/surveys');

let admin;
test.before(async () => { await start(); makeUser('adm@n.local', 'admin'); admin = new Client(); await admin.login('adm@n.local', 'SenhaForte123'); });
test.after(stop);

test('fórmula: 0 = só detratores, 50 = empate, 100 = só promotores', () => {
  assert.equal(npsFromCounts(0, 0, 10).nps, 0);
  assert.equal(npsFromCounts(5, 0, 5).nps, 50);
  assert.equal(npsFromCounts(10, 0, 0).nps, 100);
  assert.equal(npsFromCounts(0, 10, 0).nps, 50, 'só neutros');
  assert.equal(npsFromCounts(6, 2, 2).nps, 70, 'clássico +40 vira 70');
  assert.equal(npsFromCounts(0, 0, 0).nps, null);
});

test('metas aceitam de 0 a 100', async () => {
  assert.equal((await admin.req('POST', '/api/admin/branches', { body: { code: 'N1', name: 'Loja N', nps_goal: -10 } })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/branches', { body: { code: 'N1', name: 'Loja N', nps_goal: 101 } })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/branches', { body: { code: 'N1', name: 'Loja N', nps_goal: 80 } })).status, 201);
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { defaultNpsGoal: -5 } })).status, 400);
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { defaultNpsGoal: 70 } })).json.defaultNpsGoal, 70);
});

test('atualização converte uma única vez as metas gravadas na escala antiga (−100 a +100)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nps-mig-'));
  const env = { ...process.env, DB_FILE: path.join(dir, 'old.db'), DATA_DIR: dir, NODE_ENV: 'test' };
  // Banco "antigo": metas -20 e 40 e meta padrão 30, sem a marca da nova escala.
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.DB_FILE);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('defaultNpsGoal','30');");
    db.exec("CREATE TABLE branches (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, city TEXT, survey_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, nps_goal INTEGER);");
    db.exec("INSERT INTO branches (code, name, created_at, nps_goal) VALUES ('A','A',1,-20), ('B','B',1,40), ('C','C',1,NULL)");`], { env });
  const read = () => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
    const { all, get } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))});
    console.log(JSON.stringify({ goals: all('SELECT nps_goal FROM branches ORDER BY id').map((r) => r.nps_goal), def: get("SELECT value FROM settings WHERE key = 'defaultNpsGoal'").value }));`], { env }).toString());
  assert.deepEqual(read(), { goals: [40, 70, null], def: '65' });
  assert.deepEqual(read(), { goals: [40, 70, null], def: '65' }, 'na segunda vez não converte de novo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('filtro por classificação (atalho dos cards): promotores, neutros e detratores', async () => {
  const b = (await admin.req('POST', '/api/admin/branches', { body: { code: 'NF', name: 'Loja Filtro' } })).json.id;
  const sv = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Filtro', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: sv } });
  const q = (await admin.req('GET', `/api/admin/surveys/${sv}`)).json.questions[0].id;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Tab F' } });
  const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  for (const v of [10, 9, 8, 3, 0]) {
    await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok }, body: { uuid: crypto.randomUUID(), surveyId: sv, answers: [{ questionId: q, value: v }] } });
  }
  const total = async (nps) => (await admin.req('GET', `/api/admin/responses?branchId=${b}&nps=${nps}`)).json.total;
  assert.equal(await total('promotores'), 2);
  assert.equal(await total('neutros'), 1);
  assert.equal(await total('detratores'), 2);
  assert.equal(await total(''), 5);
  assert.equal((await admin.req('GET', `/api/admin/responses?nps=todos`)).status, 400);
  const stats = (await admin.req('GET', `/api/admin/stats?branchId=${b}`)).json;
  assert.equal(stats.overall.nps, 50, '2 promotores e 2 detratores em 5 = empate');
});
