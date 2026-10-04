'use strict';
// Testes de ataque: link/QR Code público, campanhas agendadas, perguntas condicionais, idiomas e horário.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { parseLocal } = require('../src/time');

let admin; let gestor; let branch; let other; let survey; let q; let token; let devTok;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60_000 - 3 * 3_600_000); // horário de Brasília (UTC-3)
  return d.toISOString().slice(0, 16);
};
const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };

test.before(async () => {
  await start();
  makeUser('adm@l.local', 'admin');
  admin = new Client(); await admin.login('adm@l.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'LK', name: 'Loja Link' } })).json.id;
  other = (await admin.req('POST', '/api/admin/branches', { body: { code: 'LO', name: 'Loja Outra' } })).json.id;
  const c = await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Pesquisa link', languages: ['pt', 'en'],
    i18n: { en: { welcome_title: 'Hello' } },
    questions: [
      { text: 'Nota?', type: 'nps', is_nps: true, i18n: { en: { text: 'Score?' } } },
      { text: 'O que podemos melhorar?', type: 'single', options: ['Preço', 'Fila'], show_if: { ref: 0, op: 'lte', value: 6 }, i18n: { en: { text: 'What to improve?', options: ['Price', 'Queue'] } } },
      { text: 'Do que mais gostou?', type: 'text', required: false, show_if: { ref: 0, op: 'gte', value: 9 } },
    ] } });
  assert.equal(c.status, 201, c.text);
  survey = c.json.id;
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tablet link' } });
  devTok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('gestor@l.local', 'gestor', 'SenhaForte123', [other]);
  gestor = new Client(); await gestor.login('gestor@l.local', 'SenhaForte123');
});
test.after(stop);

const tablet = (body) => new Client().req('POST', '/api/kiosk/responses', { body, headers: { Authorization: 'Bearer ' + devTok } });
const resp = (answers, extra = {}) => ({ uuid: crypto.randomUUID(), surveyId: survey, answers, ...extra });

test('condicionais: pergunta escondida não pode ser respondida; visível obrigatória é exigida', async () => {
  assert.equal((await tablet(resp([{ questionId: q[0].id, value: 10 }, { questionId: q[1].id, value: 'Preço' }]))).status, 400, 'pergunta de detrator respondida por promotor');
  assert.equal((await tablet(resp([{ questionId: q[0].id, value: 3 }]))).status, 400, 'detrator sem responder a obrigatória visível');
  assert.equal((await tablet(resp([{ questionId: q[0].id, value: 3 }, { questionId: q[1].id, value: 'Fila' }]))).status, 201);
  assert.equal((await tablet(resp([{ questionId: q[0].id, value: 10 }, { questionId: q[2].id, value: 'Atendimento' }]))).status, 201);
});

test('condições inválidas no editor são recusadas (referência futura, operador e valor)', async () => {
  for (const qs of [
    [{ text: 'A?', type: 'nps', show_if: { ref: 0, op: 'lte', value: 6 } }],
    [{ text: 'A?', type: 'nps' }, { text: 'B?', type: 'yesno', show_if: { ref: 1, op: 'eq', value: 'sim' } }],
    [{ text: 'A?', type: 'nps' }, { text: 'B?', type: 'yesno', show_if: { ref: 0, op: 'has', value: 6 } }],
    [{ text: 'A?', type: 'nps' }, { text: 'B?', type: 'yesno', show_if: { ref: 0, op: 'lte', value: 99 } }],
    [{ text: 'A?', type: 'single', options: ['x', 'y'] }, { text: 'B?', type: 'yesno', show_if: { ref: 0, op: 'eq', value: 'z' } }],
    [{ text: 'A?', type: 'nps' }, { text: 'B?', type: 'yesno', show_if: 'q0 <= 6' }],
  ]) assert.equal((await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Inválida', questions: qs } })).status, 400, JSON.stringify(qs));
});

test('idiomas: traduções validadas; tablet recebe as traduções; idioma inválido é ignorado', async () => {
  for (const bad of [{ languages: ['pt', 'fr'] }, { languages: 'en' }, { languages: ['pt'], i18n: { en: { welcome_title: 'Hi' } } },
    { languages: ['pt', 'en'], questions: [{ text: 'A?', type: 'single', options: ['x', 'y'], i18n: { en: { options: ['only one'] } } }] }]) {
    assert.equal((await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Idioma', questions: [{ text: 'A?', type: 'nps' }], ...bad } })).status, 400, JSON.stringify(bad));
  }
  const cfg = (await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + devTok } })).json;
  assert.deepEqual(cfg.survey.languages, ['pt', 'en']);
  assert.equal(cfg.survey.questions[1].i18n.en.options[1], 'Queue');
  const r = await tablet(resp([{ questionId: q[0].id, value: 9 }], { lang: 'xx' }));
  assert.equal(r.status, 201);
  assert.equal(get('SELECT lang FROM responses ORDER BY id DESC LIMIT 1').lang, null);
  await tablet(resp([{ questionId: q[0].id, value: 9 }], { lang: 'en' }));
  assert.equal(get('SELECT lang FROM responses ORDER BY id DESC LIMIT 1').lang, 'en');
});

test('link público: desativado por padrão; só admin ativa; gestor de outra filial não vê o QR', async () => {
  assert.equal((await gestor.req('GET', `/api/admin/branches/${branch}/public-link`)).status, 404);
  assert.equal((await gestor.req('POST', `/api/admin/branches/${other}/public-link`, { body: { enabled: true } })).status, 403);
  const on = await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.match(on.json.qr, /^data:image\/png;base64,/);
  token = on.json.url.split('/r/')[1];
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(JSON.stringify(get('SELECT public_token_enc, public_token_hash FROM branches WHERE id = ?', branch)), new RegExp(token), 'código não fica aberto no banco');
  const page = await new Client().req('GET', `/r/${token}`);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test('link público: resposta exige bilhete válido, de uso único e tempo mínimo', async () => {
  const c = new Client();
  const cfg = (await c.req('GET', `/api/link/${token}/config`)).json;
  assert.equal(cfg.branch.name, 'Loja Link');
  const body = (ticket) => resp([{ questionId: q[0].id, value: 10 }], { ticket });
  assert.equal((await c.req('POST', `/api/link/${token}/responses`, { body: body(cfg.ticket) })).status, 400, 'rápido demais (robô)');
  assert.equal((await c.req('POST', `/api/link/${token}/responses`, { body: body('x.1.y') })).status, 400, 'bilhete forjado');
  const [n, iss, sig] = cfg.ticket.split('.');
  assert.equal((await c.req('POST', `/api/link/${token}/responses`, { body: body(`${n}.${Number(iss) - 10_000}.${sig}`) })).status, 400, 'data adulterada');
  await wait(3100);
  const ok = await c.req('POST', `/api/link/${token}/responses`, { body: body(cfg.ticket) });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(get('SELECT channel FROM responses ORDER BY id DESC LIMIT 1').channel, 'link');
  assert.equal((await c.req('POST', `/api/link/${token}/responses`, { body: body(cfg.ticket) })).status, 409, 'bilhete reutilizado');
});

test('link público: filial vem do código (não do corpo); código inválido/desativado/regerado falha', async () => {
  const c = new Client();
  const cfg = (await c.req('GET', `/api/link/${token}/config`)).json;
  await wait(3100);
  await c.req('POST', `/api/link/${token}/responses`, { body: resp([{ questionId: q[0].id, value: 8 }], { ticket: cfg.ticket, branchId: other }) });
  assert.equal(get('SELECT branch_id FROM responses ORDER BY id DESC LIMIT 1').branch_id, branch);
  assert.equal((await new Client().req('GET', '/api/link/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/config')).status, 404);
  assert.equal((await new Client().req('GET', "/api/link/'%20OR%201=1--/config")).status, 404);
  const regen = await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true, regenerate: true } });
  assert.notEqual(regen.json.url.split('/r/')[1], token);
  assert.equal((await new Client().req('GET', `/api/link/${token}/config`)).status, 404, 'link antigo deixa de funcionar');
  token = regen.json.url.split('/r/')[1];
  await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: false } });
  assert.equal((await new Client().req('GET', `/api/link/${token}/config`)).status, 404, 'desativado');
  await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true } });
});

test('link público: limite de respostas por aparelho/IP', async () => {
  const c = new Client();
  let last;
  for (let i = 0; i < 12; i++) last = await c.req('POST', `/api/link/${token}/responses`, { body: resp([{ questionId: q[0].id, value: 5 }], { ticket: 'x' }) });
  assert.equal(last.status, 429);
});

test('campanhas: pesquisa agendada substitui a padrão no período; validações e escopo', async () => {
  const camp = (await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Campanha Natal', questions: [{ text: 'Natal?', type: 'nps', is_nps: true }] } })).json.id;
  for (const bad of [{ startsAt: local(10), endsAt: local(5) }, { startsAt: '2026-13-01T08:00', endsAt: local(60) }, { startsAt: local(-120), endsAt: local(-60) }, { startsAt: 'amanhã', endsAt: local(60) }]) {
    assert.equal((await admin.req('POST', '/api/admin/schedules', { body: { surveyId: camp, branchId: branch, ...bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await gestor.req('POST', '/api/admin/schedules', { body: { surveyId: camp, branchId: other, startsAt: local(-5), endsAt: local(60) } })).status, 403);
  const s = await admin.req('POST', '/api/admin/schedules', { body: { surveyId: camp, branchId: branch, startsAt: local(-5), endsAt: local(60) } });
  assert.equal(s.status, 201, s.text);
  const cfg = (await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + devTok } })).json;
  assert.equal(cfg.survey.id, camp);
  const cq = cfg.survey.questions[0].id;
  assert.equal((await tablet({ uuid: crypto.randomUUID(), surveyId: camp, answers: [{ questionId: cq, value: 10 }] })).status, 201);
  // resposta da pesquisa padrão feita há pouco (fila offline) ainda é aceita
  assert.equal((await tablet(resp([{ questionId: q[0].id, value: 9 }], { submittedAt: Date.now() - 10 * 60_000 }))).status, 201);
  assert.equal((await gestor.req('GET', '/api/admin/schedules')).json.length, 0, 'gestor não vê campanha de outra filial');
  await admin.req('DELETE', `/api/admin/schedules/${s.json.id}`);
  assert.equal((await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + devTok } })).json.survey.id, survey);
  assert.ok(parseLocal(local(0)) > 0);
});

test('horário de funcionamento: tablet recebe "fechado" fora do expediente', async () => {
  const closedAll = Array(7).fill(null);
  run('UPDATE branches SET hours_json = ? WHERE id = ?', JSON.stringify(closedAll), branch);
  const cfg = (await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + devTok } })).json;
  assert.equal(cfg.open, false);
  run('UPDATE branches SET hours_json = NULL WHERE id = ?', branch);
  assert.equal((await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + devTok } })).json.open, true);
});

test('metas e ranking aparecem nos relatórios', async () => {
  await admin.req('PUT', `/api/admin/branches/${branch}`, { body: { code: 'LK', name: 'Loja Link', nps_goal: 70 } });
  const st = (await admin.req('GET', '/api/admin/stats')).json;
  const b = st.byBranch.find((x) => x.name === 'Loja Link');
  assert.equal(b.goal, 70); assert.equal(typeof b.goalMet, 'boolean');
  assert.equal(st.ranking[0].position, 1);
  assert.ok(st.channels.some((c) => c.channel === 'link'));
});
