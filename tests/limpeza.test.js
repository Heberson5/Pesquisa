'use strict';
// Script de limpeza das pesquisas antigas: lista sem gravar; com --aplicar apaga ou arquiva, nunca toca em respostas.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const { all } = require('../src/db');

const DAY = 86_400_000;
const OLD = Date.UTC(2026, 0, 10);
const BEFORE = '2026-06-01T00:00';
const script = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'limpar-pesquisas.js'), ...args], { encoding: 'utf8', env: process.env });
let branch; let n = 0;

const mk = (title, { parent = null, created = OLD } = {}) => {
  const sid = Number(run('INSERT INTO surveys (title, welcome_title, thanks_title, parent_id, created_at, updated_at) VALUES (?,?,?,?,?,?)', title, 'Olá', 'Ok', parent, created, created).lastInsertRowid);
  run("INSERT INTO questions (survey_id, position, text, type, required, is_nps) VALUES (?,0,'Nota?','nps',1,1)", sid);
  return sid;
};
const sched = (sid, from, to) => run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', sid, branch, from, to, Date.now());
const answer = (sid) => {
  const rid = Number(run('INSERT INTO responses (uuid, survey_id, branch_id, submitted_at, received_at) VALUES (?,?,?,?,?)', `u-${++n}`, sid, branch, OLD, OLD).lastInsertRowid);
  run('INSERT INTO answers (response_id, question_id, value_num) VALUES (?,?,9)', rid, get('SELECT id FROM questions WHERE survey_id = ?', sid).id);
};
const exists = (sid) => !!get('SELECT 1 FROM surveys WHERE id = ?', sid);
const archived = (sid) => !!get('SELECT archived_at FROM surveys WHERE id = ?', sid)?.archived_at;
const responses = () => get('SELECT COUNT(*) AS n FROM responses').n;
const snapshot = () => JSON.stringify([all('SELECT * FROM surveys ORDER BY id'), all('SELECT * FROM schedules ORDER BY id'), all('SELECT id FROM questions ORDER BY id'), all('SELECT * FROM audit_log ORDER BY id')]);

let vazia; let comMomentos; let momento; let comResposta; let recente; let padrao; let nova; let noAr; let admin;
test.before(async () => {
  await start();
  makeUser('adm@l.local', 'admin');
  admin = new Client(); await admin.login('adm@l.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'LIM1', name: 'Limpeza' } })).json.id;
  vazia = mk('Vazia');
  comMomentos = mk('Principal antiga'); momento = mk('Momento', { parent: comMomentos });
  sched(momento, OLD, OLD + DAY); // período encerrado há muito tempo
  comResposta = mk('Com resposta'); answer(comResposta);
  recente = mk('Finados'); sched(recente, Date.now() - 5 * DAY, Date.now() - 4 * DAY);
  padrao = mk('Padrão da filial');
  run('UPDATE branches SET survey_id = ? WHERE id = ?', padrao, branch);
  nova = mk('Nova principal', { created: Date.parse('2026-08-01') }); answer(nova);
  noAr = mk('No ar'); sched(noAr, Date.now() - DAY, Date.now() + DAY);
});
test.after(stop);

test('sem --aplicar só lista, com contagens e a ação prevista, e nada muda', () => {
  const antes = snapshot();
  const r = script(`--before=${BEFORE}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snapshot(), antes);
  const linha = (sid) => r.stdout.split('\n').find((l) => l.startsWith(`${sid}\t`)) || '';
  assert.match(linha(vazia), /Vazia\t0\t0\tapagar/);
  assert.match(linha(comMomentos), /Principal antiga\t0\t1\tapagar/);
  assert.match(linha(comResposta), /Com resposta\t1\t0\tarquivar/);
  assert.match(linha(recente), /Finados\t0\t1\tarquivar/);
  assert.match(linha(padrao), /\tpular/);
  assert.match(linha(noAr), /\tpular/);
  assert.equal(linha(nova), '', 'criada depois de --before não aparece');
  assert.equal(linha(momento), '', 'momentos seguem a principal');
});

test('--before é obrigatório e data inválida sai com 1 sem gravar', () => {
  const antes = snapshot();
  for (const args of [[], ['--before=2026-13-45T00:00'], ['--before=ontem'], [`--aplicar=${vazia}`], ['--before=2026-06-01T00:00', '--aplicar=abc'], ['--before=2026-06-01T00:00', '--aplicar=']]) {
    const r = script(...args);
    assert.equal(r.status, 1, args.join(' '));
  }
  assert.equal(snapshot(), antes);
  assert.ok(exists(vazia));
});

test('aplica só os ids confirmados: apaga, arquiva, pula padrão e pesquisa nova, e as respostas ficam iguais', () => {
  const antes = responses();
  const r = script(`--before=${BEFORE}`, `--aplicar=${vazia},${comMomentos},${comResposta},${recente},${padrao},${noAr},${nova},99999,${momento}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(vazia), false);
  assert.equal(exists(comMomentos), false);
  assert.equal(exists(momento), false);
  assert.equal(get('SELECT COUNT(*) AS n FROM schedules WHERE survey_id = ?', momento).n, 0);
  assert.ok(exists(comResposta) && archived(comResposta));
  assert.ok(exists(recente) && archived(recente));
  assert.ok(exists(padrao) && !archived(padrao));
  assert.match(r.stderr + r.stdout, /padrão de uma filial/);
  assert.ok(exists(noAr) && !archived(noAr));
  assert.ok(exists(nova) && !archived(nova));
  assert.equal(responses(), antes);
  assert.match(r.stdout, new RegExp(`respostas antes: ${antes}; depois: ${antes}`));
  const log = all("SELECT user_id, action FROM audit_log WHERE action LIKE 'survey.%' ORDER BY id");
  assert.deepEqual(log.map((l) => l.action).sort(), ['survey.archive', 'survey.archive', 'survey.delete', 'survey.delete']);
  assert.ok(log.every((l) => l.user_id === null));
});

test('ids não listados (de fora da lista) nunca são tocados e repetir é inofensivo', () => {
  const antes = snapshot();
  const r = script(`--before=${BEFORE}`, `--aplicar=${comResposta},${nova},${padrao},${noAr}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(snapshot().replace(/"archived_at":\d+/g, ''), antes.replace(/"archived_at":\d+/g, ''));
});
