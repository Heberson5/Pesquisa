'use strict';
// Fuso horário por filial: o tablet informa o dele (modo automático), a filial pode fixar o seu, e a empresa é a reserva.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { hoursStatus } = require('../src/responses');
const zones = require('../src/zones');
const { timezone: COMPANY } = require('../src/config');
const { parseLocal } = require('../src/time');

let admin; let gestor; let branch; let tablet; let tok; let devId;
const HOURS = JSON.stringify(Array(7).fill({ open: '08:00', close: '18:00' }));

test.before(async () => {
  await start();
  makeUser('adm@z.local', 'admin');
  admin = new Client(); await admin.login('adm@z.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'ZN', name: 'Loja Fuso', alert_emails: ['loja@empresa.com'] } })).json.id;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab fuso' } });
  devId = d.json.id;
  tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('gestor@z.local', 'gestor', 'SenhaForte123', [branch]);
  gestor = new Client(); await gestor.login('gestor@z.local', 'SenhaForte123');
});
test.after(stop);

const cfg = (tz) => new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok, ...(tz === undefined ? {} : { 'X-Timezone': tz }) } });
const put = (c, body) => c.req('PUT', `/api/admin/branches/${branch}`, { body: { code: 'ZN', name: 'Loja Fuso', ...body } });

test('mesma hora do servidor, fusos diferentes: abre/fecha conforme o fuso', () => {
  const b = { hours_json: HOURS };
  const wed = Date.parse('2026-10-07T12:00:00Z'); // 09:00 Brasília · 08:00 Manaus · 07:00 Rio Branco
  assert.equal(hoursStatus(b, wed, 'America/Sao_Paulo').open, true);
  assert.equal(hoursStatus(b, wed, 'America/Manaus').open, true);
  const rb = hoursStatus(b, wed, 'America/Rio_Branco');
  assert.equal(rb.open, false); assert.match(rb.reopens, /hoje às 08:00/);
  const late = Date.parse('2026-10-07T21:30:00Z'); // 18:30 Brasília · 17:30 Manaus
  assert.equal(hoursStatus(b, late, 'America/Sao_Paulo').open, false);
  assert.equal(hoursStatus(b, late, 'America/Manaus').open, true);
});

test('só fusos do Brasil valem; o resto cai na reserva (fuso da empresa)', () => {
  for (const ok of ['America/Manaus', 'America/Sao_Paulo', 'America/Noronha', 'America/Rio_Branco']) assert.equal(zones.clean(ok), ok);
  for (const bad of ['Asia/Tokyo', 'America/New_York', 'UTC', '', null, undefined, 5, 'America/Manaus; DROP', 'x'.repeat(500), 'America/../etc', ['America/Manaus']]) assert.equal(zones.clean(bad), null, String(bad));
  assert.equal(zones.forBranch({ id: 999, timezone: 'Asia/Tokyo' }, { timezone: 'Europe/Paris' }), COMPANY);
});

test('tablet em modo automático informa o fuso, que fica salvo; fuso estranho/forjado é ignorado', async () => {
  run('UPDATE branches SET timezone = NULL WHERE id = ?', branch);
  const a = await cfg('America/Manaus');
  assert.equal(a.status, 200);
  assert.equal(a.json.timezone, 'America/Manaus');
  assert.equal(get('SELECT timezone FROM devices WHERE id = ?', devId).timezone, 'America/Manaus');
  for (const evil of ['Asia/Tokyo', 'America/New_York', "America/Manaus'; DROP TABLE devices;--", 'x'.repeat(2000), '']) {
    const r = await cfg(evil);
    assert.equal(r.status, 200, evil.slice(0, 20));
    assert.equal(r.json.timezone, 'America/Manaus', 'mantém o último fuso válido informado pelo tablet');
    assert.equal(get('SELECT timezone FROM devices WHERE id = ?', devId).timezone, 'America/Manaus');
  }
  assert.equal((await cfg()).json.timezone, 'America/Manaus', 'sem cabeçalho usa o último informado');
  run('UPDATE devices SET timezone = NULL, timezone_at = NULL WHERE id = ?', devId);
  assert.equal((await cfg('Europe/Paris')).json.timezone, COMPANY, 'fora do Brasil → fuso da empresa');
});

test('fuso escolhido na filial vale mais que o do tablet; valida entrada; "auto" volta ao automático', async () => {
  assert.equal((await put(admin, { timezone: 'America/Rio_Branco' })).status, 200);
  assert.equal((await cfg('America/Sao_Paulo')).json.timezone, 'America/Rio_Branco');
  const list = (await admin.req('GET', '/api/admin/branches')).json.find((b) => b.id === branch);
  assert.equal(list.timezone, 'America/Rio_Branco'); assert.equal(list.effective_tz, 'America/Rio_Branco');
  for (const bad of ['Asia/Tokyo', 'Foo/Bar', 5, ['America/Manaus'], 'America/Manaus\r\n']) assert.equal((await put(admin, { timezone: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await put(gestor, { timezone: 'America/Manaus' })).status, 403, 'gestor não altera a filial');
  assert.equal((await put(admin, { timezone: 'auto' })).status, 200);
  assert.equal(get('SELECT timezone FROM branches WHERE id = ?', branch).timezone, null);
  assert.equal((await cfg('America/Noronha')).json.timezone, 'America/Noronha');
  const tzs = (await gestor.req('GET', '/api/admin/timezones')).json;
  assert.equal(tzs.company, COMPANY); assert.ok(tzs.choices.length >= 4);
});

test('campanha agendada vale no fuso da filial; "todas" usa o da empresa; lista mostra o fuso', async () => {
  const sv = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Campanha fuso', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await put(admin, { timezone: 'America/Manaus' });
  const mk = (branchId) => admin.req('POST', '/api/admin/schedules', { body: { surveyId: sv, branchId, startsAt: '2030-01-10T08:00', endsAt: '2030-01-20T08:00' } });
  assert.equal((await mk(branch)).status, 201);
  assert.equal((await mk(null)).status, 201);
  const rows = (await admin.req('GET', '/api/admin/schedules')).json;
  const mine = rows.find((r) => r.branch_id === branch); const all = rows.find((r) => r.branch_id === null);
  assert.equal(mine.starts_at, Date.parse('2030-01-10T08:00:00-04:00')); assert.equal(mine.tz, 'America/Manaus');
  assert.equal(all.starts_at, parseLocal('2030-01-10T08:00', COMPANY)); assert.equal(all.tz, COMPANY);
});

test('alerta de tablet sem sinal respeita o fuso da filial', () => {
  const { checkOfflineTablets } = require('../src/scheduled');
  const now = Date.parse('2026-10-07T12:30:00Z'); // 09:30 Brasília · 07:30 Rio Branco (antes das 08:00)
  run('UPDATE branches SET hours_json = ? WHERE id = ?', HOURS, branch);
  run('UPDATE devices SET last_seen_at = ?, offline_alerted_at = NULL WHERE id = ?', now - 3 * 3_600_000, devId);
  run("UPDATE branches SET timezone = 'America/Rio_Branco' WHERE id = ?", branch);
  assert.equal(checkOfflineTablets(now), 0, 'no fuso de Rio Branco a loja ainda não abriu');
  run("UPDATE branches SET timezone = 'America/Sao_Paulo' WHERE id = ?", branch);
  assert.equal(checkOfflineTablets(now), 1, 'em Brasília já está aberta');
});
