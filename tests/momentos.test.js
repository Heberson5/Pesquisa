'use strict';
// Momentos: pesquisas filhas (parent_id) que recebem os períodos; a principal só cai no ar como padrão da filial.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

const TZ = 'America/Manaus';
const MIN = 60_000;
const local = (t) => new Date(t + -4 * 60 * MIN).toISOString().slice(0, 16);
const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
const nps = (text = 'Qual a nota?') => ({ text, type: 'nps', is_nps: true });
let admin; let branch; let padrao; let main; let m1; let m2; let token;

const mkMain = async (title, extra = {}) => (await admin.req('POST', '/api/admin/surveys', { body: { ...base, title, questions: [nps()], ...extra } })).json.id;
const mkMoment = (parent, title, questions = [nps(`${title}?`)]) => admin.req('POST', `/api/admin/surveys/${parent}/moments`, { body: { title, questions } });
const agenda = (surveyId, startsAt, endsAt, branchId = branch) => admin.req('POST', '/api/admin/schedules', { body: { surveyId, branchId, startsAt: local(startsAt), endsAt: local(endsAt) } });
const config = () => new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + token } });
const qOf = (sid) => get('SELECT id FROM questions WHERE survey_id = ?', sid).id;
const send = (sid, submittedAt) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + token },
  body: { uuid: crypto.randomUUID(), surveyId: sid, submittedAt, answers: [{ questionId: qOf(sid), value: 9 }] } });
const sched = (sid, from, to) => run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', sid, branch, from, to, Date.now());

test.before(async () => {
  await start();
  makeUser('adm@m.local', 'admin');
  admin = new Client(); await admin.login('adm@m.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'MO1', name: 'Momentos', timezone: TZ } })).json.id;
  padrao = await mkMain('Padrão');
  await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: padrao } });
  const { code } = (await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'T1' } })).json;
  token = (await new Client().req('POST', '/api/kiosk/pair', { body: { code } })).json.token;
  main = await mkMain('Dia das Mães', { welcome_text: 'Bem-vindo', thanks_text: 'Valeu', contact_mode: 'detractors', languages: ['pt', 'en'],
    i18n: { en: { welcome_title: 'Hello', thanks_title: 'Thanks' } } });
});
test.after(stop);
test.afterEach(() => run('DELETE FROM schedules'));

test('criar momento copia textos, tempos, idiomas e o modo de contato da principal', async () => {
  const r = await mkMoment(main, 'Sábado');
  assert.equal(r.status, 201, r.text);
  m1 = r.json.id;
  const m = (await admin.req('GET', `/api/admin/surveys/${m1}`)).json;
  assert.equal(m.parent_id, main);
  assert.equal(m.title, 'Sábado');
  assert.equal(m.contact_mode, 'detractors');
  assert.equal(m.welcome_title, 'Olá');
  assert.equal(m.welcome_text, 'Bem-vindo');
  assert.equal(m.thanks_text, 'Valeu');
  assert.equal(m.thanks_seconds, 5);
  assert.equal(m.idle_seconds, 30);
  assert.deepEqual(m.languages, ['pt', 'en']);
  assert.equal(m.i18n.en.welcome_title, 'Hello');
  assert.equal(m.questions.length, 1);
  assert.equal(m.parent.id, main);
  assert.equal(m.parent.title, 'Dia das Mães');
  m2 = (await mkMoment(main, 'Domingo')).json.id;
  const p = (await admin.req('GET', `/api/admin/surveys/${main}`)).json;
  assert.equal(p.parent, null);
  assert.deepEqual(p.moments.map((x) => x.id), [m1, m2]);
  assert.deepEqual(Object.keys(p.moments[0]).sort(), ['active', 'id', 'responses', 'schedules', 'title']);
});

test('momento de momento, momento sem perguntas e principal inexistente são recusados', async () => {
  assert.equal((await mkMoment(m1, 'Neto')).status, 400);
  assert.equal((await mkMoment(main, 'Vazio', [])).status, 400);
  assert.equal((await admin.req('POST', `/api/admin/surveys/${main}/moments`, { body: { title: 'Sem perguntas' } })).status, 400);
  assert.equal((await mkMoment(999999, 'Órfão')).status, 404);
  const ramo = [nps(), { text: 'Por quê?', type: 'text', show_if: { ref: 0, op: 'lte', value: 6 } }, { text: 'Fora?', type: 'text' }, { text: 'Solta?', type: 'text', show_if: { ref: 0, op: 'lte', value: 6 } }];
  assert.equal((await mkMoment(main, 'Árvore ruim', ramo)).status, 400, 'mesmas regras de árvore do PUT');
});

test('só momento é agendado; pesquisa principal que nunca teve agendamento é recusada, a antiga que já teve segue aceita', async () => {
  const t0 = Date.now() + 30 * MIN;
  const r = await agenda(main, t0, t0 + MIN * 10);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Agende um momento da pesquisa/);
  assert.equal((await agenda(m1, t0, t0 + MIN * 10)).status, 201);
  const velha = await mkMain('Finados');
  sched(velha, Date.now() - 86_400_000 * 3, Date.now() - 86_400_000 * 2);
  assert.equal((await agenda(velha, t0 + 20 * MIN, t0 + 30 * MIN)).status, 201, 'já tem histórico de agendamento');
});

test('agendamento já existente em pesquisa sem parent_id continua no ar', async () => {
  const velha = await mkMain('Finados 2');
  sched(velha, Date.now() - 5 * MIN, Date.now() + 20 * MIN);
  assert.equal((await config()).json.survey.id, velha);
});

test('filial não aceita momento como pesquisa padrão', async () => {
  const r = await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: m1 } });
  assert.equal(r.status, 400);
  assert.equal(get('SELECT survey_id FROM branches WHERE id = ?', branch).survey_id, padrao);
});

test('desativar a principal com período pendente em algum momento é recusado; momento desativa por conta própria', async () => {
  const t0 = Date.now() + 30 * MIN;
  const s = await agenda(m2, t0, t0 + 10 * MIN);
  const cur = (await admin.req('GET', `/api/admin/surveys/${main}`)).json;
  const body = { ...base, title: cur.title, contact_mode: cur.contact_mode, languages: cur.languages, i18n: cur.i18n, active: false, questions: [{ id: cur.questions[0].id, text: 'Qual a nota?', type: 'nps', is_nps: true }] };
  const r = await admin.req('PUT', `/api/admin/surveys/${main}`, { body });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /agendamentos pendentes/);
  await admin.req('DELETE', `/api/admin/schedules/${s.json.id}`);
  assert.equal((await admin.req('PUT', `/api/admin/surveys/${main}`, { body })).status, 200);
  assert.equal(get('SELECT active FROM surveys WHERE id = ?', m1).active, 1, 'o momento não é alterado');
  await admin.req('PUT', `/api/admin/surveys/${main}`, { body: { ...body, active: true } });
  const mom = (await admin.req('GET', `/api/admin/surveys/${m1}`)).json;
  const put = await admin.req('PUT', `/api/admin/surveys/${m1}`, { body: { ...base, title: 'Sábado novo', active: false, parent_id: padrao, questions: [{ id: mom.questions[0].id, text: 'Sábado?', type: 'nps', is_nps: true }] } });
  assert.equal(put.status, 200, put.text);
  assert.equal(get('SELECT parent_id FROM surveys WHERE id = ?', m1).parent_id, main, 'PUT nunca muda o parent_id');
  assert.equal(get('SELECT active FROM surveys WHERE id = ?', m1).active, 0);
  assert.equal(get('SELECT active FROM surveys WHERE id = ?', main).active, 1);
  run('UPDATE surveys SET active = 1 WHERE id = ?', m1);
});

test('o roteiro do tablet troca entre momentos e volta à padrão', async () => {
  const t0 = Date.now() + 30 * MIN;
  assert.equal((await agenda(m1, t0, t0 + 30 * MIN)).status, 201);
  assert.equal((await agenda(m2, t0 + 30 * MIN, t0 + 60 * MIN)).status, 201);
  const cfg = (await config()).json;
  assert.equal(cfg.survey.id, padrao);
  assert.deepEqual(cfg.plan.changes.map((c) => c.surveyId), [m1, m2, padrao]);
  assert.equal(cfg.plan.surveys[m1].questions.length, 1);
});

test('principal desativada não põe seus momentos no ar, nem no agora nem no roteiro', async () => {
  const t0 = Date.now();
  sched(m1, t0 - 5 * MIN, t0 + 20 * MIN);
  sched(m2, t0 + 20 * MIN, t0 + 40 * MIN);
  assert.equal((await config()).json.survey.id, m1);
  run('UPDATE surveys SET active = 0 WHERE id = ?', main);
  try {
    const cfg = (await config()).json;
    assert.equal(cfg.survey.id, padrao);
    assert.deepEqual(cfg.plan.changes, []);
  } finally { run('UPDATE surveys SET active = 1 WHERE id = ?', main); }
  assert.equal((await config()).json.survey.id, m1);
});

test('resposta offline de momento encerrado é aceita; momento nunca agendado na filial, não', async () => {
  const fim = Date.now() - 3 * 3_600_000;
  sched(m1, fim - 30 * MIN, fim);
  assert.equal((await send(m1, fim + 2 * 3_600_000)).status, 201);
  assert.equal((await send(m2, Date.now())).status, 409);
});

test('duplicar a principal copia os momentos sem períodos; duplicar um momento cria irmão sem períodos', async () => {
  const t0 = Date.now() + 30 * MIN;
  await agenda(m1, t0, t0 + 10 * MIN);
  const d = await admin.req('POST', `/api/admin/surveys/${main}/duplicate`);
  assert.equal(d.status, 201);
  const copia = d.json.id;
  const filhos = (await admin.req('GET', `/api/admin/surveys/${copia}`)).json.moments;
  assert.deepEqual(filhos.map((x) => x.title).sort(), ['Domingo', 'Sábado novo']);
  assert.ok(filhos.every((x) => x.id !== m1 && x.id !== m2 && x.schedules.length === 0));
  assert.equal(get('SELECT COUNT(*) AS n FROM schedules WHERE survey_id IN (SELECT id FROM surveys WHERE parent_id = ?)', copia).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM questions WHERE survey_id = ?', filhos[0].id).n, 1);

  const irmao = await admin.req('POST', `/api/admin/surveys/${m1}/duplicate`);
  assert.equal(irmao.status, 201);
  assert.equal(get('SELECT parent_id FROM surveys WHERE id = ?', irmao.json.id).parent_id, main);
  assert.equal(get('SELECT COUNT(*) AS n FROM schedules WHERE survey_id = ?', irmao.json.id).n, 0);
  assert.equal((await admin.req('GET', `/api/admin/surveys/${main}`)).json.moments.length, 3);
});

test('o detalhe da principal lista os períodos de cada momento', async () => {
  const t0 = Date.now() + 30 * MIN;
  await agenda(m2, t0, t0 + 10 * MIN);
  const mo = (await admin.req('GET', `/api/admin/surveys/${main}`)).json.moments.find((x) => x.id === m2);
  assert.equal(mo.schedules.length, 1);
  assert.equal(mo.schedules[0].branch_id, branch);
});

test('a lista traz só principais, com momentos e respostas somadas; all=1 traz tudo para filtros', async () => {
  sched(m2, Date.now() - MIN, Date.now() + 30 * MIN);
  assert.equal((await send(m2, Date.now())).status, 201);
  const lista = (await admin.req('GET', '/api/admin/surveys')).json;
  assert.ok(!lista.some((s) => s.id === m1 || s.id === m2));
  const p = lista.find((s) => s.id === main);
  assert.equal(p.moments, 3);
  assert.equal(p.responses, 2, 'uma de Sábado (teste anterior) e uma de Domingo');
  assert.ok(p.on_air_until > Date.now(), 'principal mostra o que está no ar em seus momentos');
  run('UPDATE surveys SET archived_at = ? WHERE id = ?', Date.now(), padrao);
  try {
    assert.ok(!(await admin.req('GET', '/api/admin/surveys')).json.some((s) => s.id === padrao), 'arquivada fora da lista');
    const todas = (await admin.req('GET', '/api/admin/surveys?all=1')).json;
    assert.ok(todas.some((s) => s.id === padrao), 'arquivada nos filtros');
    const mom = todas.find((s) => s.id === m2);
    assert.equal(mom.parent_id, main);
    assert.equal(mom.display_title, 'Dia das Mães · Domingo');
    assert.equal(todas.find((s) => s.id === main).display_title, 'Dia das Mães');
    assert.equal(mom.responses, 1);
  } finally { run('UPDATE surveys SET archived_at = NULL WHERE id = ?', padrao); }
});

test('momento de principal inativa não é agendado e a principal inativa não ganha momentos', async () => {
  const t0 = Date.now() + 30 * MIN;
  run('UPDATE surveys SET active = 0 WHERE id = ?', main);
  try {
    const r = await agenda(m1, t0, t0 + 10 * MIN);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /inativa/);
    assert.equal(get('SELECT COUNT(*) AS n FROM schedules WHERE survey_id = ?', m1).n, 0);
    assert.equal((await mkMoment(main, 'Tarde demais')).status, 400);
  } finally { run('UPDATE surveys SET active = 1 WHERE id = ?', main); }
  assert.equal((await agenda(m1, t0, t0 + 10 * MIN)).status, 201);
});

test('gestor vê no detalhe só os períodos das filiais dele e os de todas as filiais', async () => {
  const outra = (await admin.req('POST', '/api/admin/branches', { body: { code: 'MO2', name: 'Outra', timezone: TZ } })).json.id;
  makeUser('ges@m.local', 'gestor', 'SenhaForte123', [outra]);
  const ges = new Client(); await ges.login('ges@m.local', 'SenhaForte123');
  const t0 = Date.now() + 30 * MIN;
  const na = await agenda(m2, t0, t0 + 10 * MIN, branch);
  const nb = await agenda(m2, t0 + 20 * MIN, t0 + 30 * MIN, outra);
  const todas = await agenda(m2, t0 + 40 * MIN, t0 + 50 * MIN, null);
  const ids = (j) => j.moments.find((x) => x.id === m2).schedules.map((c) => c.id).sort();
  const vistoGestor = ids((await ges.req('GET', `/api/admin/surveys/${main}`)).json);
  assert.deepEqual(vistoGestor, [nb.json.id, todas.json.id].sort(), 'sem a filial fora do escopo');
  assert.deepEqual(ids((await admin.req('GET', `/api/admin/surveys/${main}`)).json), [na.json.id, nb.json.id, todas.json.id].sort());
});

test('o painel de filiais mostra "Principal · Momento" na pesquisa atual e na próxima', async () => {
  const t0 = Date.now();
  sched(m2, t0 - MIN, t0 + 10 * MIN);
  sched(m1, t0 + 10 * MIN, t0 + 20 * MIN);
  const br = (await admin.req('GET', '/api/admin/branches')).json.find((x) => x.id === branch);
  assert.equal(br.current_survey, 'Dia das Mães · Domingo');
  assert.equal(br.next_survey, 'Dia das Mães · Sábado novo');
  const lista = (await admin.req('GET', '/api/admin/schedules')).json;
  assert.ok(lista.some((c) => c.survey === 'Dia das Mães · Domingo'));
});

test('migração: banco no esquema antigo ganha parent_id e archived_at sem perder respostas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesquisa-mig-'));
  const file = path.join(dir, 'antigo.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE surveys (id INTEGER PRIMARY KEY, title TEXT NOT NULL, welcome_title TEXT NOT NULL, welcome_text TEXT, thanks_title TEXT NOT NULL,
        thanks_text TEXT, thanks_media_id TEXT, thanks_seconds INTEGER NOT NULL DEFAULT 8, idle_seconds INTEGER NOT NULL DEFAULT 45,
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE branches (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, city TEXT, survey_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE questions (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, position INTEGER NOT NULL, text TEXT NOT NULL, help_text TEXT,
        type TEXT NOT NULL CHECK (type IN ('nps','scale5','single','multi','yesno','text')), required INTEGER NOT NULL DEFAULT 1,
        is_nps INTEGER NOT NULL DEFAULT 0, options_json TEXT, display TEXT NOT NULL DEFAULT 'default' CHECK (display IN ('default','numbers','faces','icons')), icon TEXT);
      CREATE TABLE responses (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, survey_id INTEGER NOT NULL REFERENCES surveys(id), branch_id INTEGER NOT NULL,
        device_id INTEGER, started_at INTEGER, submitted_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE schedules (id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, branch_id INTEGER, starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL, created_by INTEGER, created_at INTEGER NOT NULL, CHECK (ends_at > starts_at));
      INSERT INTO surveys VALUES (1,'Finados','Olá',NULL,'Ok',NULL,NULL,8,45,1,1,1);
      INSERT INTO branches VALUES (1,'B1','Filial',NULL,1,1,1);
      INSERT INTO questions (survey_id, position, text, type) VALUES (1,0,'Nota?','nps');
      INSERT INTO responses VALUES (1,'u1',1,1,NULL,NULL,5,5), (2,'u2',1,1,NULL,NULL,6,6);
      INSERT INTO schedules VALUES (1,1,1,1000,2000,NULL,1);`);
    old.close();
    const env = { ...process.env, DB_FILE: file, DATA_DIR: dir, MEDIA_DIR: path.join(dir, 'media'), NODE_ENV: 'test' };
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "require('./src/db').db.close()"], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const db = new DatabaseSync(file);
    const cols = db.prepare('PRAGMA table_info(surveys)').all().map((c) => c.name);
    assert.ok(cols.includes('parent_id') && cols.includes('archived_at'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 1);
    const s = db.prepare('SELECT parent_id, archived_at, active FROM surveys').get();
    assert.equal(s.parent_id, null);
    assert.equal(s.archived_at, null);
    assert.equal(s.active, 1);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- excluir e arquivar
const del = (sid) => admin.req('DELETE', `/api/admin/surveys/${sid}`);
const arq = (sid) => admin.req('POST', `/api/admin/surveys/${sid}/archive`);
const resp = (sid, at = Date.now()) => run('INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, received_at) VALUES (?,?,?,?,?)', crypto.randomUUID(), sid, branch, at, at);
const exists = (sid) => !!get('SELECT 1 AS x FROM surveys WHERE id = ?', sid);

test('excluir sem respostas e sem período apaga a pesquisa e as perguntas, com auditoria', async () => {
  const s = await mkMain('Excluir livre');
  const r = await del(s);
  assert.equal(r.status, 200, r.text);
  assert.ok(!exists(s));
  assert.equal(get('SELECT COUNT(*) AS n FROM questions WHERE survey_id = ?', s).n, 0);
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'survey.delete'"));
  assert.equal((await del(s)).status, 404);
});

test('excluir e arquivar são só do administrador', async () => {
  makeUser('ges2@m.local', 'gestor', 'SenhaForte123', [branch]);
  const g = new Client(); await g.login('ges2@m.local', 'SenhaForte123');
  const s = await mkMain('Gestor não exclui');
  assert.equal((await g.req('DELETE', `/api/admin/surveys/${s}`)).status, 403);
  assert.equal((await g.req('POST', `/api/admin/surveys/${s}/archive`)).status, 403);
  assert.ok(exists(s));
});

test('excluir recusa resposta, período pendente, no ar, encerrado há menos de 30 dias e padrão de filial', async () => {
  const comResp = await mkMain('Com resposta'); resp(comResp);
  const r1 = await del(comResp);
  assert.equal(r1.status, 409); assert.match(r1.json.error, /respostas/i);

  const mom = (await mkMoment(await mkMain('Principal'), 'Momento')).json.id;
  sched(mom, Date.now() + 3_600_000, Date.now() + 7_200_000);
  const r2 = await del(mom);
  assert.equal(r2.status, 409); assert.match(r2.json.error, /per[ií]odo/i);
  run('DELETE FROM schedules');
  sched(mom, Date.now() - MIN, Date.now() + 3_600_000);
  assert.equal((await del(mom)).status, 409);
  run('DELETE FROM schedules');
  sched(mom, Date.now() - 5 * 86_400_000, Date.now() - 4 * 86_400_000);
  const r3 = await del(mom);
  assert.equal(r3.status, 409); assert.match(r3.json.error, /30 dias/);
  run('DELETE FROM schedules');
  sched(mom, Date.now() - 40 * 86_400_000, Date.now() - 39 * 86_400_000);
  assert.equal((await del(mom)).status, 200, 'encerrado há mais de 30 dias não bloqueia');

  const r4 = await del(padrao);
  assert.equal(r4.status, 409); assert.match(r4.json.error, /padr[aã]o/i);
  assert.ok(exists(padrao));
});

test('excluir principal com momento bloqueado não apaga nada; sem bloqueio apaga principal, momentos, períodos e perguntas', async () => {
  const p = await mkMain('Árvore');
  const a = (await mkMoment(p, 'Alfa')).json.id;
  const b = (await mkMoment(p, 'Beta')).json.id;
  resp(b);
  const r = await del(p);
  assert.equal(r.status, 409, r.text);
  assert.ok(exists(p) && exists(a) && exists(b));
  assert.equal(get('SELECT COUNT(*) AS n FROM questions WHERE survey_id IN (?,?,?)', p, a, b).n, 3);
  run('DELETE FROM responses WHERE survey_id = ?', b);
  sched(a, Date.now() - 60 * 86_400_000, Date.now() - 59 * 86_400_000);
  assert.equal((await del(p)).status, 200);
  for (const x of [p, a, b]) assert.ok(!exists(x));
  assert.equal(get('SELECT COUNT(*) AS n FROM schedules WHERE survey_id IN (?,?)', a, b).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM questions WHERE survey_id IN (?,?,?)', p, a, b).n, 0);
});

test('arquivar principal arquiva os momentos, mantém active e tira da lista', async () => {
  const p = await mkMain('Arquivar árvore');
  const a = (await mkMoment(p, 'Alfa')).json.id;
  const r = await arq(p);
  assert.equal(r.status, 200, r.text);
  for (const x of [p, a]) {
    const row = get('SELECT active, archived_at FROM surveys WHERE id = ?', x);
    assert.equal(row.active, 1);
    assert.ok(row.archived_at);
  }
  assert.ok(!(await admin.req('GET', '/api/admin/surveys')).json.some((s) => s.id === p));
  assert.ok((await admin.req('GET', '/api/admin/surveys?all=1')).json.some((s) => s.id === a));
  assert.ok(get("SELECT 1 AS x FROM audit_log WHERE action = 'survey.archive'"));
  assert.equal((await arq(p)).status, 409, 'já arquivada');
});

test('arquivar recusa período no ar ou pendente (inclusive de momento) e padrão de filial; momento sozinho segue a mesma regra', async () => {
  const p = await mkMain('Arquivar bloqueado');
  const a = (await mkMoment(p, 'Alfa')).json.id;
  const b = (await mkMoment(p, 'Beta')).json.id;
  sched(a, Date.now() + 3_600_000, Date.now() + 7_200_000);
  assert.equal((await arq(p)).status, 409);
  assert.equal((await arq(a)).status, 409);
  assert.equal(get('SELECT COUNT(*) AS n FROM surveys WHERE archived_at IS NOT NULL AND id IN (?,?,?)', p, a, b).n, 0, 'nada arquivado');
  assert.equal((await arq(b)).status, 200, 'momento sem período arquiva sozinho');
  assert.ok(get('SELECT archived_at FROM surveys WHERE id = ?', b).archived_at);
  assert.equal(get('SELECT archived_at FROM surveys WHERE id = ?', p).archived_at, null);
  run('DELETE FROM schedules');
  sched(a, Date.now() - 2 * 86_400_000, Date.now() - 86_400_000);
  assert.equal((await arq(p)).status, 200, 'período encerrado não impede arquivar');
  assert.equal((await arq(padrao)).status, 409);
  assert.equal(get('SELECT archived_at FROM surveys WHERE id = ?', padrao).archived_at, null);
});

test('arquivada não recebe momento, agendamento, padrão de filial nem edição', async () => {
  const p = await mkMain('Arquivada sem uso');
  const a = (await mkMoment(p, 'Alfa')).json.id;
  await arq(p);
  const r1 = await mkMoment(p, 'Novo');
  assert.equal(r1.status, 409, r1.text);
  const r2 = await agenda(a, Date.now() + 3_600_000, Date.now() + 7_200_000);
  assert.equal(r2.status, 409, r2.text);
  const r3 = await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: p } });
  assert.equal(r3.status, 409, r3.text);
  const cur = (await admin.req('GET', `/api/admin/surveys/${p}`)).json;
  const r4 = await admin.req('PUT', `/api/admin/surveys/${p}`, { body: { ...cur, title: 'Mudou' } });
  assert.equal(r4.status, 409, r4.text);
  assert.equal(get('SELECT title FROM surveys WHERE id = ?', p).title, 'Arquivada sem uso');
  assert.equal(get('SELECT survey_id FROM branches WHERE id = ?', branch).survey_id, padrao);
});

test('arquivada segue aceitando respostas da fila: momento com período encerrado há menos de 24 h', async () => {
  const p = await mkMain('Arquivada com fila');
  const a = (await mkMoment(p, 'Alfa')).json.id;
  const fim = Date.now() - 3 * 3_600_000;
  sched(a, fim - 30 * MIN, fim);
  assert.equal((await arq(p)).status, 200);
  assert.ok(get('SELECT archived_at FROM surveys WHERE id = ?', a).archived_at);
  assert.equal((await send(a, fim - 5 * MIN)).status, 201, 'resposta dada durante o período');
  assert.equal((await send(a, fim + 2 * 3_600_000)).status, 201, 'resposta da fila após o fim, dentro de 24 h');
  assert.equal(get('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ?', a).n, 2);
});

test('relatório continua contando respostas de pesquisa arquivada', async () => {
  const p = await mkMain('Arquivada no relatório');
  resp(p); resp(p);
  assert.equal((await admin.req('GET', `/api/admin/stats?surveyId=${p}`)).json.totalResponses, 2);
  assert.equal((await arq(p)).status, 200);
  assert.equal((await admin.req('GET', `/api/admin/stats?surveyId=${p}`)).json.totalResponses, 2);
});

test('relatório: principal soma ela e os momentos; momento filtra só ele; NPS conta cada resposta uma vez', async () => {
  const p = await mkMain('Soma');
  const a = (await mkMoment(p, 'Abertura')).json.id;
  const b = (await mkMoment(p, 'Fechamento')).json.id;
  // segunda pergunta de NPS no momento A (ramo): a resposta com as duas notas ainda conta uma vez
  const q2 = run("INSERT INTO questions (survey_id, position, text, type, is_nps) VALUES (?, 2, 'Outra nota?', 'nps', 1)", a, ).lastInsertRowid;
  const ra = resp(a);
  run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,10)', ra.lastInsertRowid, qOf(a));
  run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,0)', ra.lastInsertRowid, q2);
  const rp = resp(p);
  run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,3)', rp.lastInsertRowid, qOf(p));
  const st = async (id) => (await admin.req('GET', `/api/admin/stats?surveyId=${id}`)).json;
  const sp = await st(p);
  assert.equal(sp.totalResponses, 2);
  assert.equal(sp.overall.total, 2);
  assert.equal(sp.overall.promoters, 1);
  assert.equal(sp.overall.detractors, 1);
  assert.equal(sp.scoreDist.reduce((t, d) => t + d.n, 0), 2);
  assert.equal(sp.byBranch[0].total, 2);
  assert.ok(sp.byQuestion.some((q) => q.survey === 'Soma · Abertura'), 'quebra por pergunta com o nome Principal · Momento');
  assert.ok(sp.byQuestion.some((q) => q.survey === 'Soma'));
  const sa = await st(a);
  assert.equal(sa.totalResponses, 1);
  assert.equal(sa.overall.total, 1);
  assert.equal((await st(b)).totalResponses, 0);
  const pptx = await admin.req('GET', `/api/admin/report.pptx?surveyId=${a}`);
  assert.equal(pptx.status, 200);
  const csv = (await admin.req('GET', `/api/admin/responses.csv?surveyId=${p}`)).text;
  assert.ok(csv.includes('Soma · Abertura'), 'exportação traz Principal · Momento');
  assert.ok(csv.includes('"Soma"'));
  const list = (await admin.req('GET', `/api/admin/responses?surveyId=${p}`)).json;
  assert.deepEqual(list.rows.map((r) => r.survey).sort(), ['Soma', 'Soma · Abertura']);
});

test('relatório: momento arquivado com respostas ainda filtra e entra na soma da principal', async () => {
  const p = await mkMain('Soma arquivada');
  const a = (await mkMoment(p, 'Antigo')).json.id;
  resp(a); resp(p);
  run('UPDATE surveys SET archived_at = ? WHERE id = ?', Date.now(), a);
  const st = async (id) => (await admin.req('GET', `/api/admin/stats?surveyId=${id}`)).json.totalResponses;
  assert.equal(await st(a), 1);
  assert.equal(await st(p), 2);
});

test('casos e pesquisa de titular mostram Principal · Momento', async () => {
  const p = await mkMain('Casos');
  const a = (await mkMoment(p, 'Dia 1')).json.id;
  const rid = resp(a).lastInsertRowid;
  run("UPDATE responses SET contact_phone_lookup = 'zz-lookup' WHERE id = ?", rid);
  const caseId = run("INSERT INTO cases (response_id, branch_id, created_at, updated_at) VALUES (?,?,?,?)", rid, branch, Date.now(), Date.now()).lastInsertRowid;
  assert.equal((await admin.req('GET', `/api/admin/cases/${caseId}`)).json.survey, 'Casos · Dia 1');
});
