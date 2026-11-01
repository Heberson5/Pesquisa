'use strict';
// Painel instalável (manifesto, service worker, ícones).
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, base } = require('./helpers');

let admin;

test.before(async () => {
  await start();
  makeUser('adm@f.local', 'admin');
  admin = new Client(); await admin.login('adm@f.local', 'SenhaForte123');
});
test.after(stop);

test('manifesto do painel é válido e aponta para ícones que existem', async () => {
  const r = await fetch(base() + '/admin/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /manifest\+json/);
  const m = await r.json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/admin/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    const ic = await fetch(base() + i.src);
    assert.equal(ic.status, 200, i.src);
    assert.equal(ic.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await ic.arrayBuffer());
    assert.equal(b.readUInt32BE(16), Number(i.sizes.split('x')[0]), `largura real de ${i.src}`);
  }
});

test('service worker é JavaScript sem cache, tudo da lista dele existe e a API continua de fora', async () => {
  const r = await fetch(base() + '/admin/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const src = await r.text();
  assert.match(src, /startsWith\('\/api\/'\)\) return/);
  for (const f of JSON.parse(/SHELL = (\[.*?\])/.exec(src)[1].replace(/'/g, '"'))) assert.equal((await fetch(base() + f)).status, 200, f);
  const html = await (await fetch(base() + '/admin/')).text();
  for (const s of ['rel="manifest"', 'src="pwa.js"', 'viewport-fit=cover']) assert.ok(html.includes(s), s);
});
