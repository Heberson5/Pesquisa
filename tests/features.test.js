'use strict';
// Testes de segurança das funções de personalização e do relatório PowerPoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, stop, Client, makeUser, base } = require('./helpers');

let admin; let gestor; let branchA; let branchB; let surveyId; let videoId; let pngId;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 64]), Buffer.alloc(40)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40)]);

function pptxText(buf) {
  const file = path.join(os.tmpdir(), `rel-${process.pid}-${Date.now()}.pptx`);
  fs.writeFileSync(file, buf);
  try { return execFileSync('unzip', ['-p', file], { maxBuffer: 50e6 }).toString('utf8'); } finally { fs.rmSync(file, { force: true }); }
}

test.before(async () => {
  await start();
  makeUser('adm@f.local', 'admin');
  admin = new Client(); await admin.login('adm@f.local', 'SenhaForte123');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'FA', name: 'Filial Alfa' } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'FB', name: 'Filial Beta Secreta' } })).json.id;
  const created = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Pesquisa F', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true, display: 'icons', icon: 'heart' }, { text: 'Atendimento?', type: 'scale5', display: 'faces' }] } }));
  assert.equal(created.status, 201, created.text);
  surveyId = created.json.id;
  for (const b of [branchA, branchB]) await admin.req('PUT', `/api/admin/branches/${b}/survey`, { body: { surveyId } });
  const q = (await admin.req('GET', `/api/admin/surveys/${surveyId}`)).json.questions;
  for (const [b, name] of [[branchA, 'TA'], [branchB, 'TB']]) {
    const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: b, name: 'Tablet ' + name } });
    const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
    for (let i = 0; i < 3; i++) {
      await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
        body: { uuid: crypto.randomUUID(), surveyId, answers: [{ questionId: q[0].id, value: b === branchA ? 10 : 2 }, { questionId: q[1].id, value: 4 }] } });
    }
  }
  makeUser('gestor@f.local', 'gestor', 'SenhaForte123', [branchA]);
  gestor = new Client(); await gestor.login('gestor@f.local', 'SenhaForte123');
  pngId = (await admin.req('POST', '/api/admin/media', { raw: PNG })).json.id;
  videoId = (await admin.req('POST', '/api/admin/media', { raw: MP4 })).json.id;
});
test.after(stop);

test('estilo de exibição e ícone da pergunta são gravados e enviados ao tablet', async () => {
  const s = (await admin.req('GET', `/api/admin/surveys/${surveyId}`)).json;
  assert.equal(s.questions[0].display, 'icons'); assert.equal(s.questions[0].icon, 'heart');
  assert.equal(s.questions[1].display, 'faces');
});

test('estilo padrão (números/carinhas coloridos) e esquema de cores são salvos e chegam ao tablet', async () => {
  for (const [defaultDisplay, colorScheme] of [['numbers', 'bands'], ['faces', 'gradient'], ['icons', 'bands']]) {
    const r = await admin.req('PUT', '/api/admin/settings', { body: { defaultDisplay, colorScheme } });
    assert.equal(r.status, 200, r.text);
    const pub = (await new Client().req('GET', '/api/public/branding')).json;
    assert.equal(pub.defaultDisplay, defaultDisplay); assert.equal(pub.colorScheme, colorScheme);
  }
  const base = { title: 'Pesquisa padrão', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
  const c = await admin.req('POST', '/api/admin/surveys', { body: { ...base, questions: [{ text: 'Nota?', type: 'nps' }, { text: 'Escala?', type: 'scale5', display: 'default' }] } });
  assert.equal(c.status, 201, c.text);
  const qs = (await admin.req('GET', `/api/admin/surveys/${c.json.id}`)).json.questions;
  assert.deepEqual(qs.map((q) => q.display), ['default', 'default']);
});

test('estilo/ícone inválidos na pergunta são recusados', async () => {
  const base = { title: 'Pesquisa X', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
  assert.equal((await admin.req('POST', '/api/admin/surveys', { body: { ...base, questions: [{ text: 'Nota?', type: 'nps', display: 'icons', icon: 'star' }] } })).status, 201);
  for (const q of [{ text: 'Nota?', type: 'nps', display: 'slider' }, { text: 'Nota?', type: 'nps', display: 'icons', icon: '<script>' },
    { text: 'Nota?', type: 'nps', display: 'icons', icon: 'settings' }]) {
    assert.equal((await admin.req('POST', '/api/admin/surveys', { body: { ...base, questions: [q] } })).status, 400, JSON.stringify(q));
  }
});

test('gestor não recebe integrações nem destinatários das configurações (menor privilégio)', async () => {
  await admin.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: 'https://hooks.exemplo.com/segredo' }, weeklyReport: { extraEmails: ['diretoria@empresa.com'] } } });
  for (const url of ['/api/admin/settings', '/api/admin/me']) {
    const txt = (await gestor.req('GET', url)).text;
    assert.doesNotMatch(txt, /hooks\.exemplo|diretoria@|privacyText|retention|requireAdminMfa/, url);
  }
  assert.match((await admin.req('GET', '/api/admin/settings')).text, /hooks\.exemplo/);
  await admin.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: null }, weeklyReport: { extraEmails: [] } } });
});

test('configurações: só administrador altera; exige CSRF', async () => {
  assert.equal((await gestor.req('PUT', '/api/admin/settings', { body: { companyName: 'Hacker' } })).status, 403);
  assert.equal((await new Client().req('PUT', '/api/admin/settings', { body: { companyName: 'Hacker' } })).status, 401);
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { companyName: 'Hacker' }, headers: { 'X-CSRF-Token': 'x' } })).status, 403);
  assert.notEqual((await new Client().req('GET', '/api/public/branding')).json.companyName, 'Hacker');
});

test('configurações: cores, ícones e arquivos maliciosos são recusados', async () => {
  const bad = [
    { primaryColor: 'red;background:url(http://mal.com)' }, { accentColor: '#fff' }, { primaryColor: 'expression(alert(1))' },
    { ratingIcon: '<svg onload=alert(1)>' }, { ratingIcon: 'layout' }, { menuIcons: { dashboard: '"><script>' } },
    { menuIcons: { __proto__: 'x', inexistente: 'layout' } }, { menuIcons: { dashboard: 'star' } },
    { logoMediaId: '../../data/pesquisa.db' }, { logoMediaId: 'a'.repeat(32) }, { logoMediaId: videoId }, { faviconMediaId: { $ne: null } },
    { companyName: 'x' }, { companyName: 'y'.repeat(61) },
    { defaultDisplay: 'slider' }, { defaultDisplay: '<img src=x onerror=alert(1)>' }, { colorScheme: 'rainbow' }, { colorScheme: ['bands'] },
  ];
  for (const body of bad) assert.equal((await admin.req('PUT', '/api/admin/settings', { body })).status, 400, JSON.stringify(body));
});

test('configurações válidas aplicam marca pública, favicon e manifesto do app', async () => {
  const r = await admin.req('PUT', '/api/admin/settings', { body: { companyName: 'Loja A & B <teste>', primaryColor: '#123456', accentColor: '#abcdef',
    logoMediaId: pngId, faviconMediaId: pngId, appIconMediaId: pngId, ratingIcon: 'heart', menuIcons: { dashboard: 'gauge' }, faceStyle: 'mono' } });
  assert.equal(r.status, 200, r.text);
  const pub = (await new Client().req('GET', '/api/public/branding')).json;
  assert.deepEqual(Object.keys(pub).sort(), ['accentColor', 'colorScheme', 'companyName', 'defaultDisplay', 'faceStyle', 'logoUrl', 'primaryColor', 'privacyText', 'ratingIcon', 'screen']);
  assert.equal(pub.logoUrl, '/media/' + pngId);
  const fav = await new Client().req('GET', '/favicon');
  assert.equal(fav.headers.get('content-type'), 'image/png');
  const man = await new Client().req('GET', '/kiosk/manifest.webmanifest');
  assert.equal(JSON.parse(man.text).name, 'Loja A & B <teste>');
  assert.equal(JSON.parse(man.text).theme_color, '#123456');
});

test('dados do tablet incluem a marca, sem dados internos', async () => {
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchA, name: 'Tablet marca' } });
  const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  const cfg = (await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok } })).json;
  assert.equal(cfg.branding.primaryColor, '#123456');
  assert.equal(cfg.survey.questions[0].icon, 'heart');
  assert.equal(JSON.stringify(cfg).includes('menuIcons'), false);
});

test('PowerPoint: exige login e gera um .pptx válido', async () => {
  assert.equal((await new Client().req('GET', '/api/admin/report.pptx')).status, 401);
  const r = await admin.req('GET', '/api/admin/report.pptx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /presentationml/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="relatorio-nps-/);
});

test('PowerPoint do gestor contém só a filial dele e escapa nomes com & < >', async () => {
  const res = await gestorBinary('/api/admin/report.pptx');
  const xml = pptxText(res);
  assert.match(xml, /Filial Alfa/);
  assert.doesNotMatch(xml, /Filial Beta Secreta/);
  assert.match(xml, /Loja A &amp; B &lt;teste&gt;/);
  assert.equal((await gestor.req('GET', `/api/admin/report.pptx?branchId=${branchB}`)).status, 404);
});

async function gestorBinary(url) {
  const r = await fetch(base() + url, { headers: { Cookie: gestor.cookie, 'X-Forwarded-For': gestor.ip } });
  return Buffer.from(await r.arrayBuffer());
}
