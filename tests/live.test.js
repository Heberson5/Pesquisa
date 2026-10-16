'use strict';
// Tempo real (Server-Sent Events): só com login, avisa as mudanças de outros painéis e respostas novas,
// respeita o escopo de filiais e encerra quando a sessão deixa de valer.
process.env.LIVE_HEARTBEAT_MS = '150';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, base } = require('./helpers');

let admin; let gestor; let branchA; let branchB; let survey; let q; let tokB;

// Abre o canal de avisos e junta os eventos recebidos.
async function listen(c) {
  const ctrl = new AbortController();
  const res = await fetch(base() + '/api/admin/events', { headers: { Cookie: c.cookie, 'X-Forwarded-For': c.ip }, signal: ctrl.signal });
  const events = []; let ended = false;
  if (res.ok) {
    (async () => {
      const dec = new TextDecoder(); let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block);
            if (/^event: change$/m.test(block) && data) events.push(JSON.parse(data[1]));
          }
        }
      } catch { /* encerrado */ }
      ended = true;
    })();
  }
  return { status: res.status, type: res.headers.get('content-type'), events, ended: () => ended, close: () => ctrl.abort() };
}
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };

test.before(async () => {
  await start();
  makeUser('adm@l.local', 'admin');
  admin = new Client(); await admin.login('adm@l.local', 'SenhaForte123');
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'LA', name: 'Live A' } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'LB', name: 'Live B' } })).json.id;
  survey = (await admin.req('POST', '/api/admin/surveys', { body: { title: 'Live', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branchB}/survey`, { body: { surveyId: survey } });
  q = (await admin.req('GET', `/api/admin/surveys/${survey}`)).json.questions[0].id;
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchB, name: 'Tab B' } });
  tokB = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  makeUser('ges@l.local', 'gestor', 'SenhaForte123', [branchA]);
  gestor = new Client(); await gestor.login('ges@l.local', 'SenhaForte123');
});
test.after(stop);

test('sem login não abre o canal', async () => {
  const r = await fetch(base() + '/api/admin/events');
  assert.equal(r.status, 401);
});

test('o que outra pessoa grava chega na hora, sem dados (só a área)', async () => {
  const l = await listen(gestor);
  assert.equal(l.status, 200);
  assert.match(l.type, /text\/event-stream/);
  await admin.req('POST', `/api/admin/branches/${branchA}/public-link`, { body: { enabled: true } });
  assert.ok(await waitFor(() => l.events.some((e) => e.area === 'filiais')), 'ativar o QR Code avisa a tela de filiais');
  assert.deepEqual(Object.keys(l.events[0]).sort(), ['area', 'by']);
  // Gravação recusada não avisa ninguém.
  const before = l.events.length;
  await gestor.req('POST', '/api/admin/branches', { body: { code: 'XX', name: 'Proibida' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(l.events.length, before);
  l.close();
});

test('resposta nova avisa só quem enxerga a filial', async () => {
  const lg = await listen(gestor); const la = await listen(admin);
  const r = await new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tokB },
    body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q, value: 2 }] } });
  assert.equal(r.status, 201);
  assert.ok(await waitFor(() => la.events.some((e) => e.area === 'respostas') && la.events.some((e) => e.area === 'casos')), 'administrador recebe respostas e casos');
  await new Promise((r2) => setTimeout(r2, 200));
  assert.ok(!lg.events.some((e) => e.area === 'respostas'), 'gestor de outra filial não recebe');
  lg.close(); la.close();
});

test('a sessão encerrada derruba o canal aberto na próxima verificação', async () => {
  const c = new Client(); await c.login('adm@l.local', 'SenhaForte123');
  const l = await listen(c);
  assert.equal(l.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(l.ended(), false, 'continua aberto enquanto a sessão vale');
  await c.req('POST', '/api/admin/logout');
  assert.ok(await waitFor(() => l.ended(), 1500), 'encerrado depois do logout');
  assert.equal((await listen(c)).status, 401, 'o mesmo cookie não abre outro canal');
});
