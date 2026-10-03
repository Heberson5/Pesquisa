'use strict';
// Testes de segurança: simulam ataques contra a API e verificam que são bloqueados.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');

let admin; let gestorA; let branchA; let branchB; let surveyA; let surveyB; let qA; let deviceA; let deviceB;

async function pairDevice(client, branchId, name) {
  const r = await client.req('POST', '/api/admin/devices', { body: { branchId, name } });
  assert.equal(r.status, 201, r.text);
  const k = new Client();
  const p = await k.req('POST', '/api/kiosk/pair', { body: { code: r.json.code } });
  assert.equal(p.status, 200, p.text);
  return { id: r.json.id, token: p.json.token, code: r.json.code };
}
const kiosk = (token, method, url, body) => new Client().req(method, url, { body, headers: token ? { Authorization: 'Bearer ' + token } : {} });
const uuid = () => crypto.randomUUID();

test.before(async () => {
  await start();
  makeUser('admin@t.local', 'admin');
  admin = new Client();
  assert.equal((await admin.login('admin@t.local', 'SenhaForte123')).status, 200);
  branchA = (await admin.req('POST', '/api/admin/branches', { body: { code: 'A1', name: 'Filial A' } })).json.id;
  branchB = (await admin.req('POST', '/api/admin/branches', { body: { code: 'B1', name: 'Filial B' } })).json.id;
  const survey = (title) => ({ title, welcome_title: 'Olá', thanks_title: 'Obrigado', thanks_seconds: 5, idle_seconds: 30,
    questions: [
      { text: 'Recomendaria?', type: 'nps', is_nps: true },
      { text: 'Qual setor?', type: 'single', options: ['Caixa', 'Loja'] },
      { text: 'Comentário', type: 'text', required: false },
    ] });
  surveyA = (await admin.req('POST', '/api/admin/surveys', { body: survey('Pesquisa A') })).json.id;
  surveyB = (await admin.req('POST', '/api/admin/surveys', { body: survey('Pesquisa B') })).json.id;
  await admin.req('PUT', `/api/admin/branches/${branchA}/survey`, { body: { surveyId: surveyA } });
  await admin.req('PUT', `/api/admin/branches/${branchB}/survey`, { body: { surveyId: surveyB } });
  qA = (await admin.req('GET', `/api/admin/surveys/${surveyA}`)).json.questions;
  deviceA = await pairDevice(admin, branchA, 'Tablet A');
  deviceB = await pairDevice(admin, branchB, 'Tablet B');
  makeUser('gestor.a@t.local', 'gestor', 'SenhaForte123', [branchA]);
  gestorA = new Client();
  assert.equal((await gestorA.login('gestor.a@t.local', 'SenhaForte123')).status, 200);
});
test.after(stop);

// ------------------------------------------------------------------ cabeçalhos
test('cabeçalhos de segurança HTTP presentes e X-Powered-By ausente', async () => {
  const r = await new Client().req('GET', '/admin/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-powered-by'), null);
});

// ------------------------------------------------------------------ autenticação
test('todas as rotas do painel exigem login', async () => {
  const anon = new Client();
  const routes = [['GET', '/api/admin/me'], ['GET', '/api/admin/stats'], ['GET', '/api/admin/responses'], ['GET', '/api/admin/responses.csv'],
    ['GET', '/api/admin/branches'], ['GET', '/api/admin/devices'], ['GET', '/api/admin/users'], ['GET', '/api/admin/audit'],
    ['POST', '/api/admin/surveys'], ['POST', '/api/admin/media'], ['POST', '/api/admin/users'], ['POST', '/api/admin/devices']];
  for (const [m, u] of routes) assert.equal((await anon.req(m, u, { body: {} })).status, 401, `${m} ${u}`);
});

test('cookie de sessão é HttpOnly e SameSite=Strict; cookie forjado é rejeitado', async () => {
  const c = new Client();
  const r = await c.login('admin@t.local', 'SenhaForte123');
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Strict/);
  const forged = new Client(); forged.cookie = 'sid=' + 'A'.repeat(43);
  assert.equal((await forged.req('GET', '/api/admin/me')).status, 401);
});

test('mensagem de erro de login não revela se o e-mail existe', async () => {
  const a = await new Client().login('admin@t.local', 'errada');
  const b = await new Client().login('naoexiste@t.local', 'errada');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.json.error, b.json.error);
});

test('SQL injection no login não funciona', async () => {
  for (const email of ["' OR '1'='1", "admin@t.local' --", "admin@t.local'/*", '" OR 1=1 --']) {
    const r = await new Client().login(email, "' OR '1'='1");
    assert.equal(r.status, 401, email);
  }
  assert.ok(get('SELECT COUNT(*) AS n FROM users').n >= 2); // tabela intacta
});

test('conta é bloqueada após 5 senhas erradas (força bruta)', async () => {
  makeUser('vitima@t.local', 'admin');
  for (let i = 0; i < 5; i++) await new Client().login('vitima@t.local', 'chute' + i);
  const r = await new Client().login('vitima@t.local', 'SenhaForte123'); // mesmo com a senha certa
  assert.equal(r.status, 423);
});

test('limite de tentativas de login por IP (429)', async () => {
  const c = new Client();
  let last;
  for (let i = 0; i < 22; i++) last = await c.login(`x${i}@t.local`, 'qualquer');
  assert.equal(last.status, 429);
});

test('logout invalida a sessão no servidor (cookie roubado deixa de valer)', async () => {
  const c = new Client();
  await c.login('admin@t.local', 'SenhaForte123');
  const stolen = c.cookie;
  await c.req('POST', '/api/admin/logout');
  const thief = new Client(); thief.cookie = stolen;
  assert.equal((await thief.req('GET', '/api/admin/me')).status, 401);
});

// ------------------------------------------------------------------ CSRF
test('CSRF: alteração sem token, com token errado ou de outra origem é bloqueada', async () => {
  const body = { code: 'X1', name: 'Hacker' };
  assert.equal((await admin.req('POST', '/api/admin/branches', { body, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/branches', { body, headers: { 'X-CSRF-Token': 'errado' } })).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/branches', { body, headers: { Origin: 'https://site-malicioso.com' } })).status, 403);
  assert.equal(get("SELECT COUNT(*) AS n FROM branches WHERE code = 'X1'").n, 0);
});

// ------------------------------------------------------------------ isolamento entre filiais (IDOR)
test('gestor só enxerga dados da própria filial', async () => {
  await kiosk(deviceB.token, 'POST', '/api/kiosk/responses', { uuid: uuid(), surveyId: surveyB,
    answers: [{ questionId: (await admin.req('GET', `/api/admin/surveys/${surveyB}`)).json.questions[0].id, value: 3 }, { questionId: (await admin.req('GET', `/api/admin/surveys/${surveyB}`)).json.questions[1].id, value: 'Caixa' }] });
  const br = await gestorA.req('GET', '/api/admin/branches');
  assert.deepEqual(br.json.map((b) => b.id), [branchA]);
  assert.equal((await gestorA.req('GET', `/api/admin/stats?branchId=${branchB}`)).status, 404);
  assert.equal((await gestorA.req('GET', `/api/admin/responses?branchId=${branchB}`)).status, 404);
  const all = await gestorA.req('GET', '/api/admin/responses');
  assert.ok(all.json.rows.every((r) => r.branch === 'Filial A'));
  const csv = await gestorA.req('GET', '/api/admin/responses.csv');
  assert.doesNotMatch(csv.text, /Filial B/);
  const devs = await gestorA.req('GET', '/api/admin/devices');
  assert.ok(devs.json.every((d) => d.branch_id === branchA));
});

test('gestor não altera nada de outra filial nem acessa áreas de admin', async () => {
  assert.equal((await gestorA.req('POST', '/api/admin/devices', { body: { branchId: branchB, name: 'Intruso' } })).status, 404);
  assert.equal((await gestorA.req('POST', `/api/admin/devices/${deviceB.id}/revoke`)).status, 404);
  assert.equal((await gestorA.req('POST', `/api/admin/devices/${deviceB.id}/pairing-code`)).status, 404);
  assert.equal((await gestorA.req('PUT', `/api/admin/branches/${branchB}/survey`, { body: { surveyId: surveyA } })).status, 404);
  assert.equal((await gestorA.req('GET', '/api/admin/users')).status, 403);
  assert.equal((await gestorA.req('GET', '/api/admin/audit')).status, 403);
  assert.equal((await gestorA.req('POST', '/api/admin/users', { body: { name: 'Eu', email: 'eu@t.local', role: 'admin', password: 'SenhaForte123' } })).status, 403);
  assert.equal((await gestorA.req('POST', '/api/admin/surveys', { body: {} })).status, 403);
  assert.equal((await gestorA.req('POST', '/api/admin/media', { raw: Buffer.from('x') })).status, 403);
  assert.equal(get('SELECT active FROM devices WHERE id = ?', deviceB.id).active, 1);
});

test('atribuição em massa: campos extras/perfil inválido são ignorados', async () => {
  const r = await admin.req('POST', '/api/admin/users', { body: { name: 'Novo', email: 'novo@t.local', role: 'superadmin',
    password: 'SenhaForte123', id: 1, failed_logins: -100, password_hash: 'x' } });
  assert.equal(r.status, 201);
  const u = get('SELECT * FROM users WHERE id = ?', r.json.id);
  assert.equal(u.role, 'gestor'); assert.notEqual(u.id, 1); assert.match(u.password_hash, /^scrypt\$/);
});

test('política de senha recusa senhas fracas', async () => {
  for (const pw of ['123456', 'senha', 'aaaaaaaaaaaa', '1234567890']) {
    const r = await admin.req('POST', '/api/admin/users', { body: { name: 'Fraco', email: `f${pw}@t.local`, password: pw } });
    assert.equal(r.status, 400, pw);
  }
});

test('SQL injection nos filtros dos relatórios é rejeitada', async () => {
  for (const q of ["branchId=1%20OR%201=1", "surveyId=1;DROP%20TABLE%20responses", "from=2026-01-01'%20OR%20'1'='1", 'page=-1', 'branchId=1&branchId=2']) {
    const r = await admin.req('GET', '/api/admin/responses?' + q);
    assert.equal(r.status, 400, q + ' ' + r.text);
  }
  assert.ok(get('SELECT COUNT(*) AS n FROM responses').n >= 1);
});

// ------------------------------------------------------------------ quiosque
test('quiosque sem token, com token forjado ou malformado é recusado', async () => {
  assert.equal((await kiosk(null, 'GET', '/api/kiosk/config')).status, 401);
  assert.equal((await kiosk('A'.repeat(43), 'GET', '/api/kiosk/config')).status, 401);
  assert.equal((await kiosk("x' OR '1'='1", 'GET', '/api/kiosk/config')).status, 401);
});

test('tablet NÃO consegue gravar resposta em outra filial (sem mistura)', async () => {
  const id = uuid();
  const r = await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: id, surveyId: surveyA, branchId: branchB, branch_id: branchB,
    answers: [{ questionId: qA[0].id, value: 10 }, { questionId: qA[1].id, value: 'Loja' }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(get('SELECT branch_id FROM responses WHERE uuid = ?', id).branch_id, branchA);
  // tentar responder a pesquisa da outra filial
  const r2 = await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: uuid(), surveyId: surveyB, answers: [{ questionId: 1, value: 1 }] });
  assert.equal(r2.status, 409);
});

test('respostas adulteradas são recusadas (valores fora da escala, opções inexistentes, perguntas alheias)', async () => {
  const bad = [
    [{ questionId: qA[0].id, value: 11 }, { questionId: qA[1].id, value: 'Loja' }],
    [{ questionId: qA[0].id, value: -1 }, { questionId: qA[1].id, value: 'Loja' }],
    [{ questionId: qA[0].id, value: '10' }, { questionId: qA[1].id, value: 'Loja' }],
    [{ questionId: qA[0].id, value: 9.5 }, { questionId: qA[1].id, value: 'Loja' }],
    [{ questionId: qA[0].id, value: 10 }, { questionId: qA[1].id, value: 'Opção inventada' }],
    [{ questionId: qA[0].id, value: 10 }, { questionId: qA[1].id, value: { $ne: 1 } }],
    [{ questionId: qA[0].id, value: 10 }], // obrigatória ausente
    [{ questionId: qA[0].id, value: 10 }, { questionId: qA[1].id, value: 'Loja' }, { questionId: 999999, value: 1 }],
    [{ questionId: qA[0].id, value: 10 }, { questionId: qA[0].id, value: 0 }, { questionId: qA[1].id, value: 'Loja' }],
    [{ questionId: qA[0].id, value: 10 }, { questionId: qA[1].id, value: 'Loja' }, { questionId: qA[2].id, value: 'x'.repeat(1001) }],
  ];
  const before = get('SELECT COUNT(*) AS n FROM responses').n;
  for (const answers of bad) {
    const r = await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: uuid(), surveyId: surveyA, answers });
    assert.equal(r.status, 400, JSON.stringify(answers).slice(0, 120));
  }
  assert.equal((await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: 'nao-e-uuid', surveyId: surveyA, answers: [] })).status, 400);
  assert.equal(get('SELECT COUNT(*) AS n FROM responses').n, before);
});

test('reenvio da mesma resposta (fila offline) não duplica', async () => {
  const body = { uuid: uuid(), surveyId: surveyA, answers: [{ questionId: qA[0].id, value: 7 }, { questionId: qA[1].id, value: 'Caixa' }] };
  assert.equal((await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', body)).status, 201);
  const again = await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', body);
  assert.equal(again.status, 200); assert.equal(again.json.duplicate, true);
  assert.equal(get('SELECT COUNT(*) AS n FROM responses WHERE uuid = ?', body.uuid).n, 1);
});

test('tablet revogado perde acesso imediatamente', async () => {
  const d = await pairDevice(admin, branchA, 'Tablet roubado');
  assert.equal((await kiosk(d.token, 'GET', '/api/kiosk/config')).status, 200);
  await admin.req('POST', `/api/admin/devices/${d.id}/revoke`);
  assert.equal((await kiosk(d.token, 'GET', '/api/kiosk/config')).status, 401);
});

test('código de pareamento é de uso único e tem limite de tentativas', async () => {
  const r = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchA, name: 'Tablet T' } });
  const ok = await new Client().req('POST', '/api/kiosk/pair', { body: { code: r.json.code } });
  assert.equal(ok.status, 200, JSON.stringify(r.json) + ok.text);
  assert.equal((await new Client().req('POST', '/api/kiosk/pair', { body: { code: r.json.code } })).status, 400);
  const brute = new Client();
  let last;
  for (let i = 0; i < 12; i++) last = await brute.req('POST', '/api/kiosk/pair', { body: { code: 'ABCDEFG' + (i % 9 + 1) } });
  assert.equal(last.status, 429);
});

test('código de pareamento expirado não funciona', async () => {
  const r = await admin.req('POST', '/api/admin/devices', { body: { branchId: branchA, name: 'T2' } });
  run('UPDATE devices SET pair_expires_at = ? WHERE id = ?', Date.now() - 1, r.json.id);
  assert.equal((await new Client().req('POST', '/api/kiosk/pair', { body: { code: r.json.code } })).status, 400);
});

test('limite de envios por tablet (robô enchendo a pesquisa)', async () => {
  const d = await pairDevice(admin, branchA, 'Tablet spam');
  let last;
  for (let i = 0; i < 25; i++) {
    last = await kiosk(d.token, 'POST', '/api/kiosk/responses', { uuid: uuid(), surveyId: surveyA,
      answers: [{ questionId: qA[0].id, value: 0 }, { questionId: qA[1].id, value: 'Caixa' }] });
  }
  assert.equal(last.status, 429);
});

test('corpo gigante e JSON malformado são recusados sem vazar detalhes', async () => {
  const big = await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: uuid(), pad: 'x'.repeat(200_000) });
  assert.equal(big.status, 413);
  const malformed = await new Client().req('POST', '/api/admin/login', { body: '{"email": ' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(malformed.text, /at |node_modules|Error:/);
});

test('poluição de protótipo via JSON não afeta o servidor', async () => {
  await new Client().req('POST', '/api/admin/login', { body: '{"__proto__":{"role":"admin"},"constructor":{"prototype":{"role":"admin"}},"email":"a","password":"b"}' });
  assert.equal({}.role, undefined);
});

// ------------------------------------------------------------------ XSS e CSV injection
test('XSS: textos com HTML/script são guardados como texto puro (painel usa textContent)', async () => {
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const id = uuid();
  await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: id, surveyId: surveyA,
    answers: [{ questionId: qA[0].id, value: 5 }, { questionId: qA[1].id, value: 'Loja' }, { questionId: qA[2].id, value: payload }] });
  const r = await admin.req('GET', '/api/admin/responses');
  assert.equal(r.headers.get('content-type').startsWith('application/json'), true);
  const fs = require('node:fs');
  const adminJs = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'admin', 'admin.js'), 'utf8');
  const kioskJs = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'kiosk', 'kiosk.js'), 'utf8');
  for (const src of [adminJs, kioskJs]) {
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\(|new Function/);
  }
});

test('CSV injection: fórmulas são neutralizadas na exportação', async () => {
  await kiosk(deviceA.token, 'POST', '/api/kiosk/responses', { uuid: uuid(), surveyId: surveyA,
    answers: [{ questionId: qA[0].id, value: 5 }, { questionId: qA[1].id, value: 'Loja' }, { questionId: qA[2].id, value: '=HYPERLINK("http://mal.com","clique")' }] });
  const csv = await admin.req('GET', '/api/admin/responses.csv');
  assert.match(csv.text, /"'=HYPERLINK/);
  assert.doesNotMatch(csv.text, /;"=HYPERLINK/);
});

// ------------------------------------------------------------------ upload e arquivos
test('upload: SVG, HTML, PDF e executáveis disfarçados são recusados', async () => {
  const fakes = [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    Buffer.from('<!doctype html><script>alert(1)</script>'),
    Buffer.from('%PDF-1.4 ....................'),
    Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'),
  ];
  for (const f of fakes) {
    const r = await admin.req('POST', '/api/admin/media', { raw: f, headers: { 'Content-Type': 'image/png', 'X-Filename': 'foto.png' } });
    assert.equal(r.status, 415);
  }
});

test('upload válido é servido com tipo correto, nosniff e nome aleatório', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const r = await admin.req('POST', '/api/admin/media', { raw: png, headers: { 'X-Filename': encodeURIComponent('../../../etc/passwd') } });
  assert.equal(r.status, 201);
  assert.match(r.json.id, /^[a-f0-9]{32}$/);
  const m = await new Client().req('GET', r.json.url);
  assert.equal(m.headers.get('content-type'), 'image/png');
  assert.equal(m.headers.get('x-content-type-options'), 'nosniff');
});

test('path traversal: não é possível baixar banco, código-fonte ou arquivos ocultos', async () => {
  const c = new Client();
  for (const p of ['/media/..%2f..%2fdata%2fpesquisa.db', '/media/../server.js', '/kiosk/..%2f..%2fserver.js', '/admin/..%2f..%2fpackage.json',
    '/kiosk/%2e%2e/%2e%2e/src/db.js', '/data/pesquisa.db', '/src/db.js', '/package.json', '/.env', '/kiosk/.env', '/node_modules/express/package.json']) {
    const r = await c.req('GET', p);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.text, /DatabaseSync|"dependencies"|SQLite format/, p);
  }
});

test('troca de senha derruba todas as outras sessões do usuário', async () => {
  makeUser('troca@t.local', 'gestor', 'SenhaForte123', [branchA]);
  const pc1 = new Client(); const pc2 = new Client();
  await pc1.login('troca@t.local', 'SenhaForte123'); await pc2.login('troca@t.local', 'SenhaForte123');
  assert.equal((await pc1.req('POST', '/api/admin/me/password', { body: { current: 'SenhaForte123', password: 'OutraSenha456' } })).status, 200);
  assert.equal((await pc2.req('GET', '/api/admin/me')).status, 401);
});
