'use strict';
// WhatsApp por QR Code: validação, intervalo, pausa, reenvio escolhido, agradecimento, relatório e programação.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const wa = require('../src/wa');
const reports = require('../src/report-schedules');
const { listSends } = require('../src/sends');
const { parseLocal } = require('../src/time');

const PW = 'SenhaForte123';
let admin; let gestor; let b1; let b2; let survey; let token;
const online = () => wa.setState({ enabled: 1, status: 'connected', worker_at: Date.now(), qr: null });
const offline = () => wa.setState({ enabled: 1, status: 'reconnecting', worker_at: Date.now() });
const off = () => wa.setState({ enabled: 0, status: 'off', worker_at: Date.now() });
const msg = (id) => get('SELECT * FROM wa_messages WHERE id = ?', id);
const okCheck = async (n) => `${n}@s.whatsapp.net`;

test.before(async () => {
  await start();
  makeUser('adm-w@a.local', 'admin');
  admin = new Client(); await admin.login('adm-w@a.local', PW);
  b1 = (await admin.req('POST', '/api/admin/branches', { body: { code: 'W1', name: 'Filial Um', timezone: 'America/Manaus' } })).json.id;
  b2 = (await admin.req('POST', '/api/admin/branches', { body: { code: 'W2', name: 'Filial Dois' } })).json.id;
  makeUser('ges-w@a.local', 'gestor', PW, [b1]);
  gestor = new Client(); await gestor.login('ges-w@a.local', PW);
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa W', contact_mode: 'always', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${b1}/survey`, { body: { surveyId: survey } });
  const { code } = (await admin.req('POST', '/api/admin/devices', { body: { branchId: b1, name: 'Tablet W' } })).json;
  ({ token } = (await new Client().req('POST', '/api/kiosk/pair', { body: { code } })).json);
});
test.after(stop);
test.afterEach(() => { run('DELETE FROM wa_messages'); run('DELETE FROM report_schedules'); off(); });

test('Brasil é o padrão: DDD + número ganha 55; número com país é mantido; inválido é recusado', () => {
  assert.equal(wa.normalizePhone('(65) 99999-0000'), '5565999990000');
  assert.equal(wa.normalizePhone('6533334444'), '556533334444');
  assert.equal(wa.normalizePhone('5565999990000'), '5565999990000');
  assert.equal(wa.normalizePhone('123'), null);
});

test('valida antes de enviar: número sem WhatsApp vira falha com o motivo e nada é enviado', async () => {
  online();
  const id = wa.queue({ kind: 'test', recipient: '65999990000', body: 'Oi' });
  const sent = [];
  const r = await wa.processNext({ check: async () => null, send: async (...a) => sent.push(a) });
  assert.equal(r.status, 'failed');
  assert.equal(sent.length, 0);
  assert.equal(msg(id).status, 'failed');
  assert.equal(msg(id).reason, wa.NOT_ON_WHATSAPP);
});

test('intervalo sorteado fica entre 30 e 80 segundos', async () => {
  assert.equal(wa.randomInterval(() => 0), 30_000);
  assert.equal(wa.randomInterval(() => 0.999999), 80_000);
  online();
  wa.queue({ kind: 'test', recipient: '65999990000', body: 'Oi' });
  const r = await wa.processNext({ check: okCheck, send: async () => {}, rng: () => 0.5 });
  assert.equal(r.status, 'sent');
  assert.ok(r.wait >= 30_000 && r.wait <= 80_000);
});

test('agradecimento passa na frente de alerta e de relatório', async () => {
  online();
  const report = wa.queue({ kind: 'report', recipient: '65999990001', body: 'r' });
  const alert = wa.queue({ kind: 'alert', recipient: '65999990002', body: 'a' });
  const thanks = wa.queue({ kind: 'thanks', recipient: '65999990003', body: 't' });
  const order = [];
  for (let i = 0; i < 3; i++) order.push((await wa.processNext({ check: okCheck, send: async () => {} })).id);
  assert.deepEqual(order, [thanks, alert, report]);
});

test('conexão caiu: pausa tudo e não volta sozinha, nem quando reconecta', async () => {
  online();
  const a = wa.queue({ kind: 'alert', recipient: '65999990001', body: 'a', branchId: b1 });
  const b = wa.queue({ kind: 'alert', recipient: '65999990002', body: 'b', branchId: b2 });
  offline();
  wa.pauseAll();
  const durante = wa.queue({ kind: 'alert', recipient: '65999990003', body: 'c', branchId: b1 });
  for (const id of [a, b, durante]) assert.equal(msg(id).status, 'paused');
  online();
  assert.equal(await wa.processNext({ check: okCheck, send: async () => {} }), null, 'nada sai sozinho');

  // gestor só reenvia o que é das filiais dele, e a tela não mostra a outra filial
  const lista = (await gestor.req('GET', '/api/admin/sends')).json;
  assert.ok(lista.rows.every((r) => r.branch_id === b1));
  const r = await gestor.req('POST', '/api/admin/sends/resend', { body: { ids: [a, b, durante] } });
  assert.equal(r.json.count, 2);
  assert.equal(msg(a).status, 'queued');
  assert.equal(msg(b).status, 'paused');
  assert.equal((await admin.req('POST', '/api/admin/sends/resend', { body: { ids: [b] } })).json.count, 1);
});

test('reenvio é recusado enquanto estiver desconectado', async () => {
  offline();
  const id = wa.queue({ kind: 'alert', recipient: '65999990001', body: 'a', branchId: b1 });
  assert.equal((await admin.req('POST', '/api/admin/sends/resend', { body: { ids: [id] } })).status, 409);
  assert.equal(msg(id).status, 'paused');
});

test('erro de conexão no envio pausa; outro erro vira falha com o motivo', async () => {
  online();
  const a = wa.queue({ kind: 'test', recipient: '65999990001', body: 'a' });
  await wa.processNext({ check: okCheck, send: async () => { const e = new Error('caiu'); e.connectionLost = true; throw e; } });
  assert.equal(msg(a).status, 'paused');
  const b = wa.queue({ kind: 'test', recipient: '65999990002', body: 'b' });
  await wa.processNext({ check: okCheck, send: async () => { throw new Error('arquivo inválido'); } });
  assert.equal(msg(b).status, 'failed');
  assert.equal(msg(b).reason, 'arquivo inválido');
});

test('imagem e vídeo levam o texto como legenda; áudio manda o texto em seguida', () => {
  const add = (mime) => { const id = require('node:crypto').randomBytes(16).toString('hex'); run('INSERT INTO media (id, mime, size, created_at) VALUES (?,?,1,?)', id, mime, Date.now()); return id; };
  const [img] = wa.contentsFor({ media_id: add('image/png'), body: 'Oi' });
  assert.equal(img.caption, 'Oi'); assert.ok(img.image);
  const [vid] = wa.contentsFor({ media_id: add('video/mp4'), body: 'Oi' });
  assert.equal(vid.caption, 'Oi'); assert.ok(vid.video);
  const audio = wa.contentsFor({ media_id: add('audio/mpeg'), body: 'Oi' });
  assert.equal(audio.length, 2); assert.ok(audio[0].audio); assert.equal(audio[0].caption, undefined); assert.equal(audio[1].text, 'Oi');
  assert.deepEqual(wa.contentsFor({ body: 'Só texto' }), [{ text: 'Só texto' }]);
});

const answer = (contact, score = 9) => {
  const q = get('SELECT id FROM questions WHERE survey_id = ?', survey).id;
  return new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + token }, body: { uuid: crypto.randomUUID(), surveyId: survey, submittedAt: Date.now(), answers: [{ questionId: q, value: score }], contact } });
};

test('cliente que deixou telefone recebe o agradecimento, com qualquer nota', async () => {
  online();
  assert.ok((await answer({ name: 'Ana', phone: '65 99999-1234', consent: true }, 10)).status < 300);
  const m = get("SELECT * FROM wa_messages WHERE kind = 'thanks'");
  assert.equal(m.recipient, '5565999991234');
  assert.match(m.body, /Olá, Ana! .*Filial Um/);
  assert.equal(m.branch_id, b1);
  assert.equal(m.priority, 0);
});

test('sem telefone ou sem o QR Code conectado uma vez, não enfileira agradecimento', async () => {
  online();
  await answer({ email: 'a@b.com', consent: true });
  assert.equal(get("SELECT COUNT(*) AS n FROM wa_messages WHERE kind = 'thanks'").n, 0);
  off();
  await answer({ phone: '65999991234', consent: true });
  assert.equal(get("SELECT COUNT(*) AS n FROM wa_messages WHERE kind = 'thanks'").n, 0);
});

test('nota baixa manda alerta pelo QR Code para o telefone da filial', async () => {
  online();
  run('UPDATE branches SET alert_phones = ? WHERE id = ?', JSON.stringify(['65988887777']), b1);
  await answer(undefined, 2);
  const m = get("SELECT * FROM wa_messages WHERE kind = 'alert'");
  assert.equal(m.recipient, '5565988887777');
  assert.match(m.body, /nota 2/);
  run("UPDATE branches SET alert_phones = '[]' WHERE id = ?", b1);
});

test('modelos de agradecimento: exemplos prontos, edição e validação', async () => {
  const s = (await admin.req('GET', '/api/admin/settings')).json;
  assert.equal(s.whatsappThanks.templates.length, 3);
  assert.equal(s.whatsappCountry, '55');
  const save = (whatsappThanks) => admin.req('PUT', '/api/admin/settings', { body: { whatsappThanks } });
  assert.equal((await save({ ...s.whatsappThanks, activeId: 'nao-existe' })).status, 400);
  assert.equal((await save({ ...s.whatsappThanks, templates: [{ id: 'a', name: 'A', text: '' }] })).status, 400);
  assert.equal((await save({ enabled: true, activeId: 'a', templates: [{ id: 'a', name: 'A', text: 'Oi', mediaId: 'f'.repeat(32) }] })).status, 400);
  assert.equal((await save({ enabled: true, activeId: 'a', templates: [{ id: 'a', name: 'A', text: 'Oi {nome}', mediaId: null }] })).status, 200);
  await save(s.whatsappThanks);
  assert.equal((await gestor.req('PUT', '/api/admin/settings', { body: { whatsappCountry: '1' } })).status, 403);
  assert.equal((await gestor.req('GET', '/api/admin/settings')).json.whatsappThanks, undefined);
});

test('conexão e programações são só do administrador; o QR Code nunca vai para o gestor', async () => {
  for (const [m, p] of [['GET', '/whatsapp/status'], ['POST', '/whatsapp/connect'], ['POST', '/whatsapp/disconnect'], ['POST', '/whatsapp/test'], ['GET', '/report-schedules'], ['POST', '/report-schedules']]) {
    assert.equal((await gestor.req(m, '/api/admin' + p)).status, 403, p);
  }
  wa.setState({ status: 'qr', qr: 'codigo-de-teste', worker_at: Date.now() });
  assert.match((await admin.req('GET', '/api/admin/whatsapp/status')).json.qr, /^data:image\/png/);
  assert.equal((await admin.req('POST', '/api/admin/whatsapp/connect')).status, 200);
  assert.equal(wa.state().command, 'connect');
  wa.setState({ command: null, qr: null });
});

test('o relatório de envios traz data, destinatário, situação e motivo, e entra no PowerPoint', async () => {
  online();
  const id = wa.queue({ kind: 'thanks', recipient: '65999990001', body: 'a', branchId: b1 });
  await wa.processNext({ check: async () => null, send: async () => {} });
  const { rows, totals } = listSends({ id: 0, role: 'admin' }, {});
  const r = rows.find((x) => x.id === id);
  assert.equal(r.reason, wa.NOT_ON_WHATSAPP);
  assert.equal(r.tz, 'America/Manaus');
  assert.equal(r.recipient, '5565999990001');
  assert.ok(totals.failed >= 1);
  const ppt = await admin.req('GET', '/api/admin/report.pptx');
  assert.equal(ppt.status, 200);
});

test('filtro de envios usa o dia local da filial', async () => {
  online();
  const id = wa.queue({ kind: 'alert', recipient: '65999990001', body: 'a', branchId: b1 });
  run('UPDATE wa_messages SET created_at = ? WHERE id = ?', parseLocal('2026-03-05T23:30', 'America/Manaus'), id);
  const day = (d) => listSends({ id: 0, role: 'admin' }, { from: d, to: d, channel: 'wa_qr' }).rows.length;
  assert.equal(day('2026-03-05'), 1);
  assert.equal(day('2026-03-06'), 0);
});

const base = { name: 'Semanal', frequency: 'weekly', weekday: 1, hour: 8, minute: 30, periodMode: 'previous', channels: ['wa_qr'], extraPhones: ['65999990009'] };
const at = (s, tz = 'America/Sao_Paulo') => parseLocal(s, tz);

test('programação: só canais ativos são aceitos e listados', async () => {
  off();
  assert.equal((await admin.req('GET', '/api/admin/report-schedules')).json.active.some((c) => c.key === 'wa_qr'), false);
  assert.equal((await admin.req('POST', '/api/admin/report-schedules', { body: base })).status, 400);
  online();
  assert.equal((await admin.req('GET', '/api/admin/report-schedules')).json.active.some((c) => c.key === 'wa_qr'), true);
  assert.equal((await admin.req('POST', '/api/admin/report-schedules', { body: base })).status, 201);
  assert.equal((await admin.req('POST', '/api/admin/report-schedules', { body: { ...base, channels: [] } })).status, 400);
});

test('programação: dia, hora, dia fixo em mês curto e uma vez por dia', () => {
  const s = { active: 1, frequency: 'weekly', weekday: 1, day_of_month: 1, hour: 8, minute: 30, branch_id: null, last_run_key: null };
  assert.equal(reports.isDue(s, at('2026-11-02T08:29')), false, 'antes do horário');
  assert.equal(reports.isDue(s, at('2026-11-02T08:30')), true, 'segunda-feira');
  assert.equal(reports.isDue(s, at('2026-11-03T08:30')), false, 'terça-feira');
  assert.equal(reports.isDue({ ...s, last_run_key: '2026-11-02' }, at('2026-11-02T09:00')), false, 'já enviado hoje');
  const m = { ...s, frequency: 'monthly', day_of_month: 31 };
  assert.equal(reports.isDue(m, at('2026-02-28T09:00')), true, 'fevereiro: último dia');
  assert.equal(reports.isDue(m, at('2026-02-27T09:00')), false);
  assert.equal(reports.isDue({ ...s, frequency: 'daily' }, at('2026-11-03T08:30')), true);
  assert.equal(reports.isDue({ ...s, active: 0 }, at('2026-11-02T08:30')), false);
});

test('programação: período sem o dia atual, configurável', () => {
  const w = { frequency: 'weekly', period_mode: 'previous', period_days: 7 };
  assert.deepEqual(reports.periodFor(w, '2026-11-02'), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(reports.periodFor({ ...w, frequency: 'daily' }, '2026-11-02'), { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(reports.periodFor({ ...w, frequency: 'monthly' }, '2026-03-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(reports.periodFor({ ...w, period_mode: 'days', period_days: 3 }, '2026-11-02'), { from: '2026-10-30', to: '2026-11-01' });
});

test('programação roda: gera o PowerPoint, enfileira no canal e não repete no mesmo dia', async () => {
  online();
  const id = (await admin.req('POST', '/api/admin/report-schedules', { body: { ...base, frequency: 'daily' } })).json.id;
  const now = at('2026-11-02T09:00');
  assert.equal(await reports.runDue(now), 1);
  const m = get("SELECT * FROM wa_messages WHERE kind = 'report'");
  assert.equal(m.recipient, '5565999990009');
  assert.ok(m.file_path && require('node:fs').existsSync(m.file_path));
  assert.equal(wa.contentsFor(m)[0].fileName.endsWith('.pptx'), true);
  assert.equal(await reports.runDue(now), 0);
  require('node:fs').rmSync(m.file_path, { force: true });
  assert.equal(get('SELECT last_run_key FROM report_schedules WHERE id = ?', id).last_run_key, '2026-11-02');
});

test('canal que caiu depois de programado aparece como falha no relatório', async () => {
  online();
  await admin.req('POST', '/api/admin/report-schedules', { body: { ...base, frequency: 'daily' } });
  off();
  await reports.runDue(at('2026-11-03T09:00'));
  const m = get("SELECT * FROM wa_messages WHERE kind = 'report'");
  assert.equal(m.status, 'failed');
  assert.match(m.reason, /não conectado/);
  require('node:fs').rmSync(m.file_path, { force: true });
});

test('relatório semanal antigo vira programação uma única vez', async () => {
  run("DELETE FROM settings WHERE key = 'state.weeklyMigrated'");
  await admin.req('PUT', '/api/admin/settings', { body: { weeklyReport: { enabled: true, weekday: 3, hour: 7, extraEmails: ['dir@a.local'] } } });
  reports.migrateWeekly();
  reports.migrateWeekly();
  const rows = (await admin.req('GET', '/api/admin/report-schedules')).json.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weekday, 3); assert.equal(rows[0].hour, 7);
  assert.deepEqual(rows[0].channels, ['email']); assert.deepEqual(rows[0].extra_emails, ['dir@a.local']);
  assert.equal((await admin.req('GET', '/api/admin/settings')).json.weeklyReport.enabled, false);
});

test('exclusão a pedido do titular apaga também as mensagens com o nome e telefone dele', async () => {
  online();
  await answer({ name: 'Bia', phone: '65999997777', consent: true });
  assert.ok(get("SELECT 1 AS x FROM wa_messages WHERE recipient = '5565999997777'"));
  assert.equal((await admin.req('POST', '/api/admin/privacy/erase', { body: { phone: '65999997777', confirm: true } })).status, 200);
  assert.equal(get("SELECT 1 AS x FROM wa_messages WHERE recipient = '5565999997777'"), undefined);
});
