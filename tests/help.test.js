'use strict';
// Manual (Ajuda) e notas de versão (Novidades): conteúdo íntegro, versão atual registrada e janela de novidades.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, stop, Client, makeUser } = require('./helpers');

const HELP = path.join(__dirname, '..', 'public', 'admin', 'ajuda');
const index = JSON.parse(fs.readFileSync(path.join(HELP, 'index.json'), 'utf8'));
const news = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'novidades.json'), 'utf8'));
const version = require('../package.json').version;
const { MODULES } = require('../src/permissions');

test.before(start);
test.after(stop);

test('cada artigo existe, as imagens existem e os links internos apontam para artigos reais', () => {
  const slugs = new Set(index.map((a) => a.slug));
  const modules = new Set(MODULES.map((m) => m.key));
  assert.equal(slugs.size, index.length, 'sem artigo repetido');
  for (const a of index) {
    const md = fs.readFileSync(path.join(HELP, a.slug + '.md'), 'utf8');
    assert.ok(md.length > 200, `${a.slug} tem conteúdo`);
    for (const m of a.perm || []) assert.ok(modules.has(m), `${a.slug}: permissão ${m} existe`);
    for (const [, img] of md.matchAll(/!\[[^\]]*\]\((img\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(HELP, img)), `${a.slug}: imagem ${img}`);
    for (const [, slug] of md.matchAll(/\]\(#\/ajuda\/([a-z0-9-]+)\)/g)) assert.ok(slugs.has(slug), `${a.slug}: link para ${slug}`);
    assert.doesNotMatch(md, /<[a-z]/i, `${a.slug}: sem HTML no texto`);
  }
});

test('notas de versão: a versão atual está registrada; imagens e artigos citados existem', () => {
  assert.equal(news[0].version, version, 'a primeira versão da lista é a do package.json');
  const slugs = new Set(index.map((a) => a.slug));
  for (const v of news) {
    assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const i of v.items) {
      assert.ok(['novo', 'melhoria', 'correcao'].includes(i.type), `${v.version}: tipo ${i.type}`);
      if (i.image) assert.ok(fs.existsSync(path.join(HELP, 'img', i.image)), `${v.version}: imagem ${i.image}`);
      if (i.help) assert.ok(slugs.has(i.help), `${v.version}: artigo ${i.help}`);
    }
  }
});

test('"O que há de novo" aparece uma vez por pessoa e por versão', async () => {
  makeUser('novo@h.local', 'gestor');
  const c = new Client(); await c.login('novo@h.local', 'SenhaForte123');
  let me = (await c.req('GET', '/api/admin/me')).json;
  assert.equal(me.appVersion, version);
  assert.equal(me.user.lastSeenVersion, null);
  assert.equal((await c.req('POST', '/api/admin/me/seen-version')).status, 200);
  me = (await c.req('GET', '/api/admin/me')).json;
  assert.equal(me.user.lastSeenVersion, version);
});

test('o manual e as novidades são servidos ao painel', async () => {
  const c = new Client();
  assert.equal((await c.req('GET', '/admin/ajuda/index.json')).status, 200);
  assert.equal((await c.req('GET', '/admin/ajuda/qr-code.md')).status, 200);
  assert.equal((await c.req('GET', '/admin/novidades.json')).status, 200);
});
