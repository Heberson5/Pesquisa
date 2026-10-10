'use strict';
// Testes: relatório semanal por e-mail (escopo por gestor) e alerta de tablet sem sinal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

let admin; let bA; let bB; let devA;
const pptxText = (buf) => {
  const f = path.join(os.tmpdir(), `w-${process.pid}-${Date.now()}.pptx`); fs.writeFileSync(f, buf);
  try { return execFileSync('unzip', ['-p', f]).toString('utf8'); } finally { fs.rmSync(f, { force: true }); }
};

test.before(async () => {
  await start();
  makeUser('adm@s.local', 'admin');
  admin = new Client(); await admin.login('adm@s.local', 'SenhaForte123');
  bA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'SA', name: 'Semanal Alfa' } })).json.id;
  bB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'SB', name: 'Semanal Beta Sigilosa' } })).json.id;
  const sv = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Semanal', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  const q = (await admin.req('GET', `/api/admin/surveys/${sv}`)).json.questions[0].id;
  for (const b of [bA, bB]) {
    await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId: sv } });
    const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Tab ' + b } });
    const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
    if (b === bA) devA = d.json.id;
    for (let i = 0; i < 3; i++) {
      await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
        body: { uuid: crypto.randomUUID(), surveyId: sv, answers: [{ questionId: q, value: 9 }], submittedAt: Date.now() - 2 * 86_400_000 } });
    }
  }
  makeUser('gestor.sa@s.local', 'gestor', 'SenhaForte123', [bA]);
});
test.after(stop);

test('relatório semanal: só envia no dia/hora configurados e uma vez por dia', async () => {
  const { sendWeeklyReport } = require('../src/scheduled');
  assert.equal((await sendWeeklyReport()).skipped, 'desativado');
  await admin.req('PUT', '/api/admin/settings', { body: { weeklyReport: { enabled: true, weekday: 1, hour: 8 } } });
  // Datas relativas a hoje: as respostas foram feitas há 2 dias; o relatório sai na segunda-feira seguinte a elas.
  const { localNow } = require('../src/time');
  let m = Date.now() - 2 * 86_400_000 + 86_400_000;
  while (localNow(m).weekday !== 1) m += 86_400_000;
  const monday = localNow(m).date;
  const monday9 = Date.parse(`${monday}T09:00:00-03:00`); const monday7 = Date.parse(`${monday}T07:00:00-03:00`);
  const tuesday = monday9 + 86_400_000;
  assert.equal((await sendWeeklyReport({ now: monday7 })).skipped, 'fora do horário');
  assert.equal((await sendWeeklyReport({ now: tuesday })).skipped, 'fora do horário');
  const r = await sendWeeklyReport({ now: monday9 });
  assert.ok(r.sent >= 2, JSON.stringify(r));
  assert.equal((await sendWeeklyReport({ now: monday9 + 3_600_000 })).skipped, 'já enviado hoje');
});

test('relatório semanal: gestor recebe PowerPoint apenas com as filiais dele', async () => {
  const mail = get("SELECT * FROM outbox WHERE kind = 'weekly_report' AND recipient = 'gestor.sa@s.local' ORDER BY id DESC LIMIT 1");
  assert.ok(mail && mail.attachment, 'e-mail com anexo');
  const xml = pptxText(Buffer.from(mail.attachment));
  assert.match(xml, /Semanal Alfa/);
  assert.doesNotMatch(xml, /Semanal Beta Sigilosa/);
  assert.doesNotMatch(mail.body_html, /Semanal Beta Sigilosa/);
  const adm = get("SELECT * FROM outbox WHERE kind = 'weekly_report' AND recipient = 'adm@s.local' ORDER BY id DESC LIMIT 1");
  assert.match(pptxText(Buffer.from(adm.attachment)), /Semanal Beta Sigilosa/);
});

test('relatório semanal: e-mails extras inválidos são recusados; só admin dispara envio manual', async () => {
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { weeklyReport: { extraEmails: ['diretoria@empresa.com\nBcc: x@y.z'] } } })).status, 400);
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { weeklyReport: { weekday: 9 } } })).status, 400);
  const g = new Client(); await g.login('gestor.sa@s.local', 'SenhaForte123');
  assert.equal((await g.req('POST', '/api/admin/settings/weekly-report/send-now')).status, 403);
});

test('tablet sem sinal: alerta só no horário de funcionamento e uma vez por queda', async () => {
  const { checkOfflineTablets } = require('../src/scheduled');
  run('UPDATE devices SET last_seen_at = ? WHERE id = ?', Date.now() - 3 * 3_600_000, devA);
  run('UPDATE branches SET hours_json = ? WHERE id = ?', JSON.stringify(Array(7).fill(null)), bA); // fechada
  assert.equal(checkOfflineTablets(), 0, 'filial fechada: sem alerta');
  run('UPDATE branches SET hours_json = NULL WHERE id = ?', bA);
  const before = get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'device_offline'").n;
  assert.equal(checkOfflineTablets(), 1);
  assert.ok(get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'device_offline'").n > before);
  assert.equal(checkOfflineTablets(), 0, 'não repete o alerta da mesma queda');
});
