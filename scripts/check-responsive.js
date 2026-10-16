'use strict';
// Confere o painel em telas pequenas: abre cada tela, aba e janela em 360 px de largura (temas claro e escuro)
// e falha se algo passar da largura da tela (rolagem lateral ou conteúdo cortado).
// Uso: npm run test:telas   (sobe um servidor temporário com dados de demonstração; precisa do Chromium do Playwright)
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIDTHS = (process.env.WIDTHS || '360').split(',').map(Number);
const PORT = Number(process.env.CHECK_PORT || 3099);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'TelasPequenas123';
const ROOT = path.join(__dirname, '..');

// [nome, rota, ação opcional depois de abrir]
const clickText = (sel, text) => async (p) => { await p.locator(sel, { hasText: text }).first().click(); await p.waitForTimeout(600); };
const SCREENS = [
  ['Visão geral', 'dashboard'], ['Casos', 'casos'], ['Caso aberto', 'casos', async (p) => { await p.locator('a.btn', { hasText: 'Abrir' }).first().click(); await p.waitForTimeout(700); }],
  ['Respostas', 'respostas'], ['Pesquisas', 'pesquisas'], ['Agendar campanha', 'pesquisas', clickText('button', 'Agendar campanha')],
  ['Editor de pesquisa', 'pesquisas', async (p) => { await p.locator('a.btn', { hasText: 'Editar' }).first().click(); await p.waitForTimeout(900); }],
  ['Nova pesquisa', 'pesquisas/nova'],
  ['Filiais', 'filiais'], ['Nova filial', 'filiais', clickText('button', 'Nova filial')], ['QR Code da filial', 'filiais', clickText('button', 'QR Code')],
  ['Tablets', 'dispositivos'], ['Novo tablet', 'dispositivos', clickText('button', 'Novo tablet')], ['Guia do tablet', 'dispositivos', clickText('button', 'Guia de instalação')],
  ['Usuários', 'usuarios'], ['Novo usuário', 'usuarios', clickText('button', 'Novo usuário')],
  ['Permissões', 'permissoes'], ['Novo perfil', 'permissoes', clickText('button', 'Novo perfil')],
  ...['Identidade visual', 'Ícones do menu', 'Ícones das respostas', 'E-mail e WhatsApp', 'Modelos de mensagem', 'Alertas e relatórios', 'Segurança e LGPD']
    .map((t) => [`Configurações · ${t}`, 'configuracoes', async (p) => { await selectTab(p, t); }]),
  ['Auditoria', 'auditoria'], ['Ajuda', 'ajuda/qr-code'], ['Busca na ajuda', 'ajuda', async (p) => { await p.fill('.help-search input', 'whatsapp'); await p.waitForTimeout(500); }],
  ['Novidades', 'novidades'], ['Minha conta', 'conta'], ['Ativar 2FA', 'conta', clickText('button', 'Ativar 2FA')],
];

// Guias: no celular viram uma lista de seleção; em telas largas, botões.
async function selectTab(p, label) {
  const sel = p.locator('select.tabs-select');
  if (await sel.count() && await sel.first().isVisible()) await sel.first().selectOption({ label });
  else await p.locator('.tabs button', { hasText: label }).first().click();
  await p.waitForTimeout(1200);
}

// Elementos que passam da largura da tela e não estão dentro de uma área com rolagem própria.
const findOverflow = () => {
  const W = document.documentElement.clientWidth;
  const out = [];
  const scrollable = (el) => { for (let e = el.parentElement; e; e = e.parentElement) { const o = getComputedStyle(e).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return e !== document.body && e !== document.documentElement; } return false; };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).position === 'fixed') continue;
    if (r.right > W + 1 || r.left < -1) {
      if (scrollable(el)) continue;
      if (el.closest('.side') && !el.closest('.layout.mobile-open')) continue; // menu lateral escondido fora da tela
      const name = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      out.push(`${name} [${Math.round(r.left)}–${Math.round(r.right)}] "${(el.textContent || '').trim().slice(0, 40)}"`);
    }
  }
  return { scrollWidth: document.documentElement.scrollWidth, width: W, offenders: out.slice(0, 8) };
};

async function main() {
  const { chromium } = require('playwright');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telas-'));
  const env = { ...process.env, DATA_DIR: dir, PORT: String(PORT), DISABLE_JOBS: 'true', DEMO_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'development', PUBLIC_URL: BASE };
  const nodeArgs = ['--disable-warning=ExperimentalWarning'];
  execFileSync(process.execPath, [...nodeArgs, 'scripts/seed-demo.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const server = spawn(process.execPath, [...nodeArgs, 'server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const failures = [];
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 200)); }
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    for (const width of WIDTHS) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 780 }, colorScheme: theme, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(BASE + '/admin/');
        let r = await page.evaluate(findOverflow);
        if (r.offenders.length || r.scrollWidth > r.width) failures.push({ width, theme, screen: 'Login', ...r });
        await page.fill('input[type=email]', 'admin@demo.local'); await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]');
        await page.waitForSelector('.layout');
        for (const [name, hash, action] of SCREENS) {
          await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach((m) => m.remove()));
          await page.goto(`${BASE}/admin/#/${hash}`); await page.waitForTimeout(700);
          if (action) { try { await action(page); } catch (e) { failures.push({ width, theme, screen: name, offenders: ['não foi possível abrir: ' + e.message.split('\n')[0]] }); continue; } }
          if (process.env.CHECK_SELFTEST && name === 'Visão geral') await page.evaluate(() => { const d = document.createElement('div'); d.style.width = '600px'; d.style.height = '10px'; document.querySelector('.main').append(d); });
          r = await page.evaluate(findOverflow);
          if (r.offenders.length || r.scrollWidth > r.width) failures.push({ width, theme, screen: name, ...r });
          await page.keyboard.press('Escape').catch(() => {});
        }
        // Menu lateral aberto no celular.
        await page.goto(`${BASE}/admin/#/dashboard`); await page.waitForTimeout(500);
        await page.click('.mobile-bar button'); await page.waitForTimeout(400);
        r = await page.evaluate(findOverflow);
        if (r.scrollWidth > r.width) failures.push({ width, theme, screen: 'Menu aberto', ...r });
        if (errors.length) failures.push({ width, theme, screen: 'Erros de JavaScript', offenders: errors });
        // Tablet e página do QR Code (cliente no celular).
        for (const [name, url] of [['Tablet (ativação)', '/kiosk/']]) {
          await page.goto(BASE + url); await page.waitForTimeout(800);
          r = await page.evaluate(findOverflow);
          if (r.offenders.length || r.scrollWidth > r.width) failures.push({ width, theme, screen: name, ...r });
        }
        await page.close();
      }
    }
    await browser.close();
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\n${failures.length} problema(s) em telas pequenas:\n`);
    for (const f of failures) console.error(`• ${f.screen} — ${f.width}px, tema ${f.theme === 'dark' ? 'escuro' : 'claro'}${f.scrollWidth > f.width ? ` (rolagem lateral: ${f.scrollWidth}px)` : ''}\n    ${(f.offenders || []).join('\n    ')}`);
    process.exit(1);
  }
  console.log(`Telas pequenas OK: ${SCREENS.length + 3} telas em ${WIDTHS.join(', ')} px, temas claro e escuro.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
