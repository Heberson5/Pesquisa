'use strict';
// Ramificações: operador de faixa (between) e perguntas ocultas por condição.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser } = require('./helpers');
const { all } = require('../src/db');

const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30 };
let admin; let token; let branch; let n = 0;

const mk = async (questions) => {
  const r = await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: `Ramo ${++n}`, questions } });
  if (r.status === 201) await admin.req('PUT', `/api/admin/branches/${branch}/survey`, { body: { surveyId: r.json.id } });
  return r;
};
const nps = (extra = {}) => ({ text: 'Qual a nota?', type: 'nps', is_nps: true, ...extra });
const filha = (show_if, extra = {}) => ({ text: 'O que melhorar?', type: 'text', required: true, show_if, ...extra });
const ids = (sid) => all('SELECT id FROM questions WHERE survey_id = ? ORDER BY position, id', sid).map((r) => r.id);
const send = (sid, answers) => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + token },
  body: { uuid: crypto.randomUUID(), surveyId: sid, submittedAt: Date.now(), answers } });

test.before(async () => {
  await start();
  makeUser('adm@r.local', 'admin');
  admin = new Client(); await admin.login('adm@r.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'RM1', name: 'Ramo', timezone: 'America/Manaus' } })).json.id;
  const { code } = (await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'T1' } })).json;
  token = (await new Client().req('POST', '/api/kiosk/pair', { body: { code } })).json.token;
});
test.after(stop);

test('between é aceito em NPS com faixa válida', async () => {
  const r = await mk([nps(), filha({ ref: 0, op: 'between', value: [7, 8] })]);
  assert.equal(r.status, 201, r.text);
});

test('between é recusado com faixa invertida, fora da escala ou em yesno', async () => {
  for (const value of [[8, 7], [0, 11], [-1, 5], [7.5, 8], [7], 'x']) {
    const r = await mk([nps(), filha({ ref: 0, op: 'between', value })]);
    assert.equal(r.status, 400, JSON.stringify(value));
  }
  const r = await mk([{ text: 'Gostou?', type: 'yesno' }, filha({ ref: 0, op: 'between', value: [1, 2] })]);
  assert.equal(r.status, 400);
  const s5 = await mk([{ text: 'Estrelas?', type: 'scale5' }, filha({ ref: 0, op: 'between', value: [0, 3] })]);
  assert.equal(s5.status, 400);
  const ok5 = await mk([{ text: 'Estrelas?', type: 'scale5' }, filha({ ref: 0, op: 'between', value: [2, 3] })]);
  assert.equal(ok5.status, 201, ok5.text);
});

test('nota dentro da faixa exige a filha obrigatória; fora dela não', async () => {
  const sid = (await mk([nps(), filha({ ref: 0, op: 'between', value: [7, 8] })])).json.id;
  const [qm, qf] = ids(sid);
  assert.equal((await send(sid, [{ questionId: qm, value: 7 }])).status, 400);
  assert.equal((await send(sid, [{ questionId: qm, value: 7 }, { questionId: qf, value: 'Rapidez' }])).status, 201);
  assert.equal((await send(sid, [{ questionId: qm, value: 9 }])).status, 201);
  assert.equal((await send(sid, [{ questionId: qm, value: 9 }, { questionId: qf, value: 'x' }])).status, 400);
});

test('sem a resposta da mãe, filha e neta obrigatórias não são exigidas', async () => {
  const sid = (await mk([
    nps({ required: false }),
    filha({ ref: 0, op: 'between', value: [7, 8] }, { type: 'yesno', text: 'Filha?' }),
    filha({ ref: 1, op: 'eq', value: 'sim' }, { text: 'Neta?' }),
    { text: 'Outra', type: 'text', required: false },
  ])).json.id;
  const [, , , qo] = ids(sid);
  assert.equal((await send(sid, [{ questionId: qo, value: 'oi' }])).status, 201);
});

test('só duas camadas de ramificação abaixo da principal: o nível 3 é recusado', async () => {
  const ok = await mk([nps(), filha({ ref: 0, op: 'lte', value: 6 }, { type: 'yesno', text: 'Filha?' }),
    filha({ ref: 1, op: 'eq', value: 'sim' }, { type: 'yesno', text: 'Neta?' })]);
  assert.equal(ok.status, 201, ok.text);
  const r = await mk([nps(), filha({ ref: 0, op: 'lte', value: 6 }, { type: 'yesno', text: 'Filha?' }),
    filha({ ref: 1, op: 'eq', value: 'sim' }, { type: 'yesno', text: 'Neta?' }),
    filha({ ref: 2, op: 'eq', value: 'sim' }, { text: 'Bisneta?' })]);
  assert.equal(r.status, 400, r.text);
});

test('a filha precisa ficar dentro do bloco da mãe', async () => {
  const r = await mk([nps(), { text: 'Sem ligação', type: 'text', required: false }, filha({ ref: 0, op: 'lte', value: 6 })]);
  assert.equal(r.status, 400, r.text);
  const ok = await mk([nps(), filha({ ref: 0, op: 'lte', value: 6 }, { required: false }), filha({ ref: 0, op: 'gte', value: 9 }, { required: false }),
    { text: 'Depois', type: 'text', required: false }]);
  assert.equal(ok.status, 201, ok.text);
});

test('com respostas: show_if e ordem congelados, textos seguem editáveis', async () => {
  const sid = (await mk([nps(), filha({ ref: 0, op: 'lte', value: 6 }, { required: false }), { text: 'Outra', type: 'text', required: false }])).json.id;
  const qs = (await admin.req('GET', `/api/admin/surveys/${sid}`)).json.questions;
  assert.ok(qs.every((q) => Number.isInteger(q.id)));
  assert.equal((await send(sid, [{ questionId: qs[0].id, value: 9 }])).status, 201);
  const put = (qlist, extra = {}) => admin.req('PUT', `/api/admin/surveys/${sid}`, { body: { ...base, title: 'Ramo congelado', ...extra,
    questions: qlist.map((q) => ({ id: q.id, text: q.text, type: q.type, required: q.required, is_nps: q.is_nps, options: q.options, show_if: q.show_if })) } });
  assert.equal((await put(qs)).status, 200);
  const texto = (id) => all('SELECT text FROM questions WHERE id = ?', id)[0].text;

  const mudou = qs.map((q, i) => (i === 1 ? { ...q, show_if: { ref: 0, op: 'lte', value: 5 } } : q));
  assert.equal((await put(mudou)).status, 409);
  const solta = qs.map((q, i) => (i === 1 ? { ...q, show_if: null } : q));
  assert.equal((await put(solta)).status, 409);

  const outraOrdem = [qs[0], qs[2], qs[1]].map((q, i) => (i === 0 ? q : { ...q, text: q.text + ' x', show_if: q.show_if && { ref: 0, op: q.show_if.op, value: q.show_if.value } }));
  const r = await put(outraOrdem);
  assert.equal(r.status, 409);
  assert.equal(texto(qs[1].id), 'O que melhorar?');
  assert.equal(texto(qs[2].id), 'Outra');

  const semId = await admin.req('PUT', `/api/admin/surveys/${sid}`, { body: { ...base, title: 'Ramo congelado',
    questions: qs.map((q) => ({ text: q.text, type: q.type, required: q.required, is_nps: q.is_nps, options: q.options, show_if: q.show_if })) } });
  assert.equal(semId.status, 409);
  assert.match(semId.json.error, /recarregu/i);

  const edit = qs.map((q, i) => (i === 2 ? { ...q, text: 'Outra, editada' } : q));
  const c = await put(edit);
  assert.equal(c.status, 409);
  assert.equal(c.json.code, 'HISTORY_CHANGE');
  assert.equal((await put(edit, { confirmHistory: true })).status, 200);
  assert.equal(texto(qs[2].id), 'Outra, editada');
});
