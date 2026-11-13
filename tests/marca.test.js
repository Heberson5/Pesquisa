'use strict';
// A marca de quem desenvolveu o sistema (Sauberlich System) em todas as telas, nos e-mails e no relatório.
// Se for retirada de algum desses lugares, este teste falha — e a atualização não vai para o servidor.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SAUBERLICH_CREDIT, sauberlichCopyright } = require('../src/marca');
const { renderEmail } = require('../src/notify');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('o texto da marca é o combinado', () => {
  assert.strictEqual(SAUBERLICH_CREDIT, 'Desenvolvido por Sauberlich System');
  assert.strictEqual(sauberlichCopyright(2026), '© 2026 Sauberlich System · Todos os direitos reservados');
  const shared = read('public/shared/marca.js');
  assert.ok(shared.includes("credit: 'Desenvolvido por Sauberlich System'"));
  assert.ok(shared.includes('Sauberlich System · Todos os direitos reservados'));
});

test('todo e-mail leva a marca no rodapé (HTML e texto)', () => {
  const { html, text } = renderEmail({ title: 'Aviso', intro: 'Texto', brand: { companyName: 'Empresa' } });
  assert.ok(html.includes(SAUBERLICH_CREDIT));
  assert.ok(text.includes(SAUBERLICH_CREDIT));
});

test('o relatório em PowerPoint leva a marca na capa e em todos os slides', () => {
  const report = read('src/report.js');
  assert.ok(report.includes("{ text: { text: SAUBERLICH_CREDIT,"), 'capa');
  assert.ok(report.includes('${period}  ·  ${SAUBERLICH_CREDIT}'), 'slides de conteúdo');
});

test('painel: direito autoral nas telas de entrar e "Desenvolvido por" no menu de todas as páginas', () => {
  assert.ok(read('public/admin/index.html').includes('<script src="/shared/marca.js"></script>'));
  const admin = read('public/admin/admin.js');
  assert.ok(admin.includes("h('p', { class: 'login-credit' }, window.SauberlichMarca.copyright())"));
  assert.ok(admin.includes("h('span', { class: 'credit-full' }, window.SauberlichMarca.credit)"));
});

test('quiosque: "Desenvolvido por" no pé da tela', () => {
  assert.ok(read('public/kiosk/index.html').includes('<div class="credit" aria-hidden="true">Desenvolvido por Sauberlich System</div>'));
  assert.ok(read('public/kiosk/kiosk.css').includes('.credit {'));
});
