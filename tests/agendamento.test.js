'use strict';
// Agendamentos ligados à pesquisa: troca automática, roteiro do tablet e proteção contra esquecimento.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { parseLocal } = require('../src/time');

const TZ = 'America/Manaus';
const MIN = 60_000;
const local = (t) => new Date(t + -4 * 60 * MIN).toISOString().slice(0, 16);
const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
let admin; let gestor; let branch; let other; let padrao; let a; let b; let token; let otherToken; let principal;

const mkSurvey = async (title) => (await admin.req('POST', '/api/admin/surveys', { body: { ...base, title, questions: [{ text: `${title}?`, type: 'nps', is_nps: true }] } })).json.id;
// Só momentos recebem períodos: A e B são momentos de uma pesquisa principal.
const mkMoment = async (title) => (await admin.req('POST', `/api/admin/surveys/${principal}/moments`, { body: { title, questions: [{ text: `${title}?`, type: 'nps', is_nps: true }] } })).json.id;
const agenda = (body) => admin.req('POST', '/api/admin/schedules', { body });
const config = (tok = token) => new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok } });
const qOf = (sid) => get('SELECT id FROM questions WHERE survey_id = ?', sid).id;
const send = (sid, submittedAt, tok = token) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
  body: { uuid: crypto.randomUUID(), surveyId: sid, submittedAt, answers: [{ questionId: qOf(sid), value: 9 }] } });
const pair = async (branchId) => {
  const { code } = (await admin.req('POST', '/api/admin/devices', { body: { branchId, name: `T${branchId}` } })).json;
  return (await new Client().req('POST', '/api/kiosk/pair', { body: { code } })).json.token;
};

test.before(async () => {
  await start();
  makeUser('adm@a.local', 'admin');
  admin = new Client(); await admin.login('adm@a.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'AG1', name: 'Agenda', timezone: TZ } })).json.id;
  other = (await admin.req('POST', '/api/admin/branches', { body: { code: 'AG2', name: 'Outra', timezone: TZ } })).json.id;
  padrao = await mkSurvey('Padrão'); principal = await mkSurvey('Campanha'); a = await mkMoment('Pesquisa A'); b = await mkMoment('Pesquisa B');
  for (const id of [branch, other]) await admin.req('PUT', `/api/admin/branches/${id}/survey`, { body: { surveyId: padrao } });
  token = await pair(branch); otherToken = await pair(other);
  makeUser('ges@a.local', 'gestor', 'SenhaForte123', [other]);
  gestor = new Client(); await gestor.login('ges@a.local', 'SenhaForte123');
});
test.after(stop);
test.afterEach(() => run('DELETE FROM schedules'));

test('o tablet recebe o roteiro de trocas com as pesquisas, na ordem, voltando à padrão no fim', async () => {
  const t0 = Date.now() + 30 * MIN;
  assert.equal((await agenda({ surveyId: a, branchId: branch, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) })).status, 201);
  assert.equal((await agenda({ surveyId: b, branchId: branch, startsAt: local(t0 + 30 * MIN), endsAt: local(t0 + 60 * MIN) })).status, 201);
  const cfg = (await config()).json;
  assert.equal(cfg.survey.id, padrao);
  assert.ok(Math.abs(cfg.plan.serverNow - Date.now()) < 5000);
  assert.deepEqual(cfg.plan.changes.map((c) => c.surveyId), [a, b, padrao], 'A → B sem passo intermediário, e volta à padrão');
  assert.equal(cfg.plan.changes[0].at, parseLocal(local(t0), TZ));
  for (const id of [a, b, padrao]) assert.equal(cfg.plan.surveys[id].id, id);
  assert.equal(cfg.plan.surveys[a].questions.length, 1);
  assert.deepEqual((await config(otherToken)).json.plan.changes, [], 'agendamento de uma filial não aparece na outra');
});

test('agendamento em andamento vale na hora e o roteiro leva até o retorno', async () => {
  await agenda({ surveyId: a, branchId: branch, startsAt: local(Date.now() - 5 * MIN), endsAt: local(Date.now() + 10 * MIN) });
  const cfg = (await config()).json;
  assert.equal(cfg.survey.id, a);
  assert.deepEqual(cfg.plan.changes.map((c) => c.surveyId), [padrao]);
});

test('"todas as filiais" entra no roteiro de cada uma; o agendamento da filial mais recente vence', async () => {
  const t0 = Date.now() + 60 * MIN;
  await agenda({ surveyId: a, branchId: null, startsAt: local(t0), endsAt: local(t0 + 60 * MIN) }); // "todas" vale no relógio local de cada filial
  await agenda({ surveyId: b, branchId: branch, startsAt: local(t0 + 20 * MIN), endsAt: local(t0 + 40 * MIN) });
  assert.deepEqual((await config()).json.plan.changes.map((c) => c.surveyId), [a, b, a, padrao]);
  assert.deepEqual((await config(otherToken)).json.plan.changes.map((c) => c.surveyId), [a, padrao]);
});

test('roteiro é só do tablet: o QR Code público não vê pesquisas futuras', async () => {
  const link = (await admin.req('POST', `/api/admin/branches/${branch}/public-link`, { body: { enabled: true } })).json.url;
  await agenda({ surveyId: a, branchId: branch, startsAt: local(Date.now() + 30 * MIN), endsAt: local(Date.now() + 60 * MIN) });
  const r = await new Client().req('GET', `/api/link/${link.split('/r/')[1]}/config`);
  assert.equal(r.status, 200);
  assert.equal(r.json.plan, undefined);
  assert.ok(!r.text.includes('Pesquisa A'));
});

test('horários sobrepostos na mesma filial são recusados; filiais diferentes e horários encostados não', async () => {
  const t0 = Date.now() + 60 * MIN;
  assert.equal((await agenda({ surveyId: a, branchId: branch, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) })).status, 201);
  const clash = await agenda({ surveyId: b, branchId: branch, startsAt: local(t0 + 10 * MIN), endsAt: local(t0 + 40 * MIN) });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /Pesquisa A/);
  assert.equal((await agenda({ surveyId: b, branchId: branch, startsAt: local(t0 + 30 * MIN), endsAt: local(t0 + 40 * MIN) })).status, 201);
  assert.equal((await agenda({ surveyId: b, branchId: other, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) })).status, 201);
});

test('resposta offline da pesquisa de um agendamento encerrado não se perde; outra filial e pesquisa alheia continuam barradas', async () => {
  const fim = Date.now() - 3 * 3_600_000;
  run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', a, branch, fim - 30 * MIN, fim, Date.now());
  assert.equal((await send(a, fim + 2 * 3_600_000)).status, 201, 'tablet sem internet seguiu com a pesquisa por 2 horas');
  assert.equal((await send(padrao, Date.now() - 5 * 3_600_000)).status, 201, 'a padrão da filial sempre é aceita');
  assert.equal((await send(b, Date.now())).status, 409, 'pesquisa nunca agendada nesta filial');
  assert.equal((await send(a, Date.now(), otherToken)).status, 409, 'agendamento de outra filial');
});

test('não dá para desativar pesquisa com agendamento pendente; depois de excluir, pode', async () => {
  const [qa] = (await admin.req('GET', `/api/admin/surveys/${a}`)).json.questions;
  const body = { ...base, title: 'Pesquisa A', active: false, questions: [{ id: qa.id, text: 'Pesquisa A?', type: 'nps', is_nps: true }] };
  const s = await agenda({ surveyId: a, branchId: branch, startsAt: local(Date.now() + 30 * MIN), endsAt: local(Date.now() + 60 * MIN) });
  const r = await admin.req('PUT', `/api/admin/surveys/${a}`, { body });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /agendamentos pendentes/);
  await admin.req('DELETE', `/api/admin/schedules/${s.json.id}`);
  assert.equal((await admin.req('PUT', `/api/admin/surveys/${a}`, { body })).status, 200);
  await admin.req('PUT', `/api/admin/surveys/${a}`, { body: { ...body, active: true } });
});

test('editar agendamento: futuro muda tudo, no ar só o fim, encerrado não muda; conflito e escopo continuam valendo', async () => {
  const edit = (sid, body, c = admin) => c.req('PUT', `/api/admin/schedules/${sid}`, { body });
  const row = (sid) => get('SELECT * FROM schedules WHERE id = ?', sid);
  const t0 = Date.now() + 60 * MIN;
  const fut = (await agenda({ surveyId: a, branchId: branch, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) })).json.id;
  const outro = (await agenda({ surveyId: b, branchId: branch, startsAt: local(t0 + 60 * MIN), endsAt: local(t0 + 90 * MIN) })).json.id;

  assert.equal((await edit(fut, { branchId: other, startsAt: local(t0 + 10 * MIN), endsAt: local(t0 + 20 * MIN) })).status, 200);
  assert.equal(row(fut).branch_id, other);
  assert.equal(row(fut).starts_at, parseLocal(local(t0 + 10 * MIN), TZ));
  assert.deepEqual((await config(otherToken)).json.plan.changes.map((c) => c.surveyId), [a, padrao], 'o roteiro do tablet segue a edição');

  await edit(fut, { branchId: branch, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) });
  const clash = await edit(fut, { branchId: branch, startsAt: local(t0 + 70 * MIN), endsAt: local(t0 + 80 * MIN) });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /Pesquisa B/);
  assert.equal(row(fut).starts_at, parseLocal(local(t0), TZ), 'recusado não altera');
  assert.equal((await edit(outro, { branchId: branch, startsAt: local(t0 + 65 * MIN), endsAt: local(t0 + 90 * MIN) })).status, 200, 'o próprio período não conta como conflito');
  assert.equal((await edit(fut, { branchId: branch, startsAt: local(t0 + 40 * MIN), endsAt: local(t0 + 30 * MIN) })).status, 400);
  assert.equal((await edit(fut, { branchId: branch, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) }, gestor)).status, 403);
  assert.equal((await edit(999999, { endsAt: local(t0) })).status, 404);

  const inicio = Date.now() - 5 * MIN;
  const noAr = Number(run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', a, other, inicio, Date.now() + 10 * MIN, Date.now()).lastInsertRowid);
  assert.equal((await edit(noAr, { branchId: branch, startsAt: local(Date.now() + 5 * MIN), endsAt: local(Date.now() + 40 * MIN) })).status, 200);
  assert.equal(row(noAr).starts_at, inicio, 'no ar: início fica');
  assert.equal(row(noAr).branch_id, other, 'no ar: filial fica');
  assert.equal(row(noAr).ends_at, parseLocal(local(Date.now() + 40 * MIN), TZ));
  assert.equal((await edit(noAr, { endsAt: local(Date.now() - 2 * MIN) })).status, 400, 'fim no passado: use Encerrar');

  const fim = Date.now() - 3 * MIN;
  const velho = Number(run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', a, branch, fim - 10 * MIN, fim, Date.now()).lastInsertRowid);
  assert.equal((await edit(velho, { branchId: branch, startsAt: local(t0), endsAt: local(t0 + 5 * MIN) })).status, 409);
});

test('o painel mostra os agendamentos da pesquisa, o que está no ar e a próxima troca, respeitando o escopo', async () => {
  const t0 = Date.now() + 30 * MIN;
  await agenda({ surveyId: a, branchId: branch, startsAt: local(Date.now() - MIN), endsAt: local(t0) });
  await agenda({ surveyId: b, branchId: branch, startsAt: local(t0), endsAt: local(t0 + 30 * MIN) });
  const only = (await admin.req('GET', `/api/admin/schedules?surveyId=${b}`)).json;
  assert.deepEqual(only.map((c) => c.survey_id), [b]);
  const list = (await admin.req('GET', '/api/admin/surveys?all=1')).json;
  assert.ok(list.find((s) => s.id === a).on_air_until > Date.now());
  assert.ok(list.find((s) => s.id === b).next_start > Date.now());
  assert.equal(list.find((s) => s.id === padrao).next_start, null);
  const br = (await admin.req('GET', '/api/admin/branches')).json.find((x) => x.id === branch);
  assert.equal(br.current_survey, 'Campanha · Pesquisa A');
  assert.equal(br.scheduled, true);
  assert.equal(br.next_survey, 'Campanha · Pesquisa B');
  assert.ok(br.next_change_at > Date.now());
  assert.equal((await gestor.req('GET', `/api/admin/schedules?surveyId=${a}`)).json.length, 0);
  assert.equal((await gestor.req('POST', '/api/admin/schedules', { body: { surveyId: a, branchId: other, startsAt: local(t0), endsAt: local(t0 + MIN) } })).status, 403);
  assert.equal((await admin.req('GET', '/api/admin/schedules?surveyId=abc')).status, 400);
});

const DAY = 86_400_000;
const mkPeriod = (from, to) => Number(run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', a, branch, from, to, Date.now()).lastInsertRowid);
const delPeriod = (sid) => admin.req('DELETE', `/api/admin/schedules/${sid}`);
const row = (sid) => get('SELECT * FROM schedules WHERE id = ?', sid);

test('excluir período que ainda não começou apaga a linha', async () => {
  const s = mkPeriod(Date.now() + DAY, Date.now() + 2 * DAY);
  const r = await delPeriod(s);
  assert.equal(r.status, 200);
  assert.equal(r.json.action, 'deleted');
  assert.equal(row(s), undefined);
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'schedule.delete'"));
});

test('excluir período no ar encerra agora, mantém a linha, audita e o tablet volta para a padrão', async () => {
  const t0 = Date.now();
  const s = mkPeriod(t0 - MIN, t0 + DAY);
  assert.equal((await config()).json.survey.id, a);
  const r = await delPeriod(s);
  assert.equal(r.status, 200);
  assert.equal(r.json.action, 'ended');
  const after = row(s);
  assert.ok(after, 'linha mantida');
  assert.ok(after.ends_at >= t0 && after.ends_at <= Date.now());
  assert.equal(after.starts_at, t0 - MIN);
  const log = get("SELECT detail FROM audit_log WHERE action = 'schedule.end' ORDER BY id DESC");
  assert.ok(log, 'auditado');
  assert.equal((await config()).json.survey.id, padrao);
  // encerrado agora: segunda tentativa cai na regra dos 30 dias
  assert.equal((await delPeriod(s)).status, 409);
});

test('período encerrado há menos de 30 dias é recusado com 409 e fica guardado', async () => {
  const s = mkPeriod(Date.now() - 10 * DAY, Date.now() - 5 * DAY);
  const r = await delPeriod(s);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /30 dias/);
  assert.match(r.json.error, /sem conexão/);
  assert.ok(row(s));
});

test('período encerrado há mais de 30 dias é apagado', async () => {
  const s = mkPeriod(Date.now() - 50 * DAY, Date.now() - 40 * DAY);
  const r = await delPeriod(s);
  assert.equal(r.status, 200);
  assert.equal(r.json.action, 'deleted');
  assert.equal(row(s), undefined);
  assert.equal((await delPeriod(s)).status, 404);
});
