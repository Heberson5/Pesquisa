'use strict';
// Gera os prints usados no manual (Ajuda) e nas notas de versão (Novidades), sempre com dados de demonstração —
// nunca com dados reais de clientes. Uso: npm run docs:prints  (precisa do Chromium do Playwright)
// Saída: public/admin/ajuda/img/*.jpg
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PRINTS_PORT || 3098);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'PrintsDemo12345';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'admin', 'ajuda', 'img');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

const wait = (p, ms = 700) => p.waitForTimeout(ms);
const go = async (p, hash) => { await p.evaluate(() => document.querySelectorAll('.modal-bg').forEach((m) => m.remove())); await p.goto(`${BASE}/admin/#/${hash}`); await wait(p, 900); };
const click = async (p, sel, text) => { await p.locator(sel, { hasText: text }).first().click(); await wait(p, 900); };
const tab = async (p, label) => {
  const sel = p.locator('select.tabs-select');
  if (await sel.count() && await sel.first().isVisible()) await sel.first().selectOption({ label });
  else await p.locator('.tabs button', { hasText: label }).first().click();
  await wait(p, 1400);
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const me = await (await fetch('/api/admin/me')).json();
  const r = await fetch('/api/admin' + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, url, body]);

// [arquivo, largura, altura, preparação]
const DESKTOP = [1280, 800];
const PHONE = [390, 780];
const SHOTS = [
  ['painel-visao-geral', DESKTOP, (p) => go(p, 'dashboard')],
  ['casos', DESKTOP, (p) => go(p, 'casos')],
  ['caso-detalhe', DESKTOP, async (p) => { await go(p, 'casos'); await click(p, 'a.btn', 'Abrir'); }],
  ['respostas', DESKTOP, (p) => go(p, 'respostas')],
  ['pesquisas', DESKTOP, (p) => go(p, 'pesquisas')],
  ['pesquisa-editor', DESKTOP, async (p) => { await go(p, 'pesquisas'); await click(p, 'a.btn', 'Editar'); }],
  ['campanha-agendar', DESKTOP, async (p) => { await go(p, 'pesquisas'); await click(p, 'button', 'Agendar campanha'); }],
  ['filiais', DESKTOP, (p) => go(p, 'filiais')],
  ['filial-editar', DESKTOP, async (p) => { await go(p, 'filiais'); await click(p, 'button', 'Editar'); }],
  ['filial-qrcode', DESKTOP, async (p) => { await go(p, 'filiais'); await click(p, 'button', 'QR Code'); }],
  ['tablets', DESKTOP, (p) => go(p, 'dispositivos')],
  ['usuarios', DESKTOP, (p) => go(p, 'usuarios')],
  ['usuario-editar', DESKTOP, async (p) => { await go(p, 'usuarios'); await p.locator('button', { hasText: 'Editar' }).nth(1).click(); await wait(p); }],
  ['permissoes', DESKTOP, (p) => go(p, 'permissoes')],
  ['config-identidade', DESKTOP, async (p) => { await go(p, 'configuracoes'); await tab(p, 'Identidade visual'); }],
  ['config-envios', DESKTOP, async (p) => { await go(p, 'configuracoes'); await tab(p, 'E-mail e WhatsApp'); }],
  ['config-modelos-whatsapp', DESKTOP, async (p) => { await go(p, 'configuracoes'); await tab(p, 'Modelos de mensagem'); }],
  ['config-modelos-email', DESKTOP, async (p) => { await go(p, 'configuracoes'); await tab(p, 'Modelos de mensagem'); await click(p, '.tabs.sub button', 'E-mail'); await wait(p, 1500); }],
  ['config-alertas', DESKTOP, async (p) => { await go(p, 'configuracoes'); await tab(p, 'Alertas e relatórios'); }],
  ['config-lgpd', DESKTOP, async (p) => { await go(p, 'configuracoes'); await tab(p, 'Segurança e LGPD'); }],
  ['minha-conta', DESKTOP, (p) => go(p, 'conta')],
  ['auditoria', DESKTOP, (p) => go(p, 'auditoria')],
  ['ajuda', DESKTOP, (p) => go(p, 'ajuda/qr-code')],
  ['novidades', DESKTOP, (p) => go(p, 'novidades')],
  ['celular-painel', PHONE, (p) => go(p, 'dashboard')],
  ['celular-menu', PHONE, async (p) => { await go(p, 'dashboard'); await p.click('.mobile-bar button'); await wait(p, 500); }],
  ['celular-configuracoes', PHONE, async (p) => { await go(p, 'configuracoes'); await tab(p, 'Modelos de mensagem'); }],
  ['celular-permissoes', PHONE, async (p) => { await go(p, 'permissoes'); await p.evaluate(() => window.scrollTo(0, 620)); await wait(p, 300); }],
];

async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prints-'));
  const env = { ...process.env, DATA_DIR: dir, PORT: String(PORT), DISABLE_JOBS: 'true', DEMO_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'development', PUBLIC_URL: 'https://pesquisa.suaempresa.com.br' };
  const nodeArgs = ['--disable-warning=ExperimentalWarning'];
  execFileSync(process.execPath, [...nodeArgs, 'scripts/seed-demo.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const server = spawn(process.execPath, [...nodeArgs, 'server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 200)); }
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    const ctx = await browser.newContext({ colorScheme: 'light', deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const p = await ctx.newPage();
    await p.setViewportSize({ width: DESKTOP[0], height: DESKTOP[1] });
    await p.goto(BASE + '/admin/');
    await p.fill('input[type=email]', 'admin@demo.local'); await p.fill('input[type=password]', PASSWORD); await p.click('button[type=submit]');
    await p.waitForSelector('.layout');
    // Preparação: foto ilustrativa do administrador, QR Code da filial ativo, WhatsApp no modo QR e um link de QR.
    await p.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
      g.fillStyle = '#cfe3f3'; g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#0f3d5e'; g.beginPath(); g.ellipse(128, 270, 110, 90, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#c98f6b'; g.beginPath(); g.arc(128, 104, 50, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3b2a20'; g.beginPath(); g.arc(128, 92, 52, Math.PI, 0); g.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const me = await (await fetch('/api/admin/me')).json();
      await fetch('/api/admin/me/photo', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': me.csrf }, body: blob });
    });
    const branches = await (await p.evaluate(() => fetch('/api/admin/branches').then((r) => r.json())));
    await api(p, 'POST', `/branches/${branches[0].id}/public-link`, { enabled: true });
    await api(p, 'PUT', '/settings', { whatsapp: { mode: 'qr' } });
    await p.reload(); await p.waitForSelector('.layout');
    for (const [name, [w, hgt], prepare] of SHOTS) {
      if (ONLY && !ONLY.has(name)) continue;
      await p.setViewportSize({ width: w, height: hgt });
      await prepare(p);
      await p.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.add('hidden'); });
      await p.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 82 });
      console.log('✓', name);
    }
    await browser.close();
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
