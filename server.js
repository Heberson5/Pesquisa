'use strict';
const path = require('node:path');
const express = require('express');
const { securityHeaders } = require('./src/security');
const { HttpError } = require('./src/validate');
const { get, run } = require('./src/db');
const { getSettings, publicBranding } = require('./src/settings');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// Atrás de um proxy reverso (nginx, Cloudflare), defina TRUST_PROXY=1 para req.ip/req.secure corretos.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false);

app.use(securityHeaders);
app.use('/api', express.json({ limit: '64kb', strict: true }));

// Identidade visual pública (tela de login e tablet). Não expõe nada sensível.
app.get('/api/public/branding', (req, res) => res.json(publicBranding()));
app.use('/api/kiosk', require('./src/routes/kiosk'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// Mídia de agradecimento: nomes aleatórios de 128 bits, tipo validado no upload.
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'data', 'media');
app.get('/media/:id', (req, res, next) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
  const m = get('SELECT id, mime FROM media WHERE id = ?', req.params.id);
  if (!m) return res.status(404).end();
  res.sendFile(path.join(MEDIA_DIR, m.id), {
    headers: { 'Content-Type': m.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'public, max-age=86400, immutable' },
  }, (err) => err && next(err));
});

// Ícones configuráveis: navegador (favicon) e aplicativo instalado no tablet.
function sendIcon(res, next, mediaId) {
  const m = mediaId ? get('SELECT id, mime FROM media WHERE id = ?', mediaId) : null;
  if (!m) return res.sendFile(path.join(__dirname, 'public', 'kiosk', 'icon.svg'), { headers: { 'Cache-Control': 'no-cache' } }, (e) => e && next(e));
  res.sendFile(path.join(MEDIA_DIR, m.id), { headers: { 'Content-Type': m.mime, 'Cache-Control': 'no-cache' } }, (e) => e && next(e));
}
app.get(['/favicon.ico', '/favicon'], (req, res, next) => sendIcon(res, next, getSettings().faviconMediaId));
app.get(['/app-icon', '/apple-touch-icon.png'], (req, res, next) => sendIcon(res, next, getSettings().appIconMediaId));
app.get('/kiosk/manifest.webmanifest', (req, res) => {
  const s = getSettings();
  const icon = s.appIconMediaId ? get('SELECT mime FROM media WHERE id = ?', s.appIconMediaId) : null;
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: s.companyName, short_name: s.companyName.slice(0, 12), start_url: '/kiosk/', scope: '/kiosk/',
    display: 'fullscreen', orientation: 'any', background_color: s.primaryColor, theme_color: s.primaryColor,
    icons: icon
      ? [{ src: '/app-icon', sizes: '512x512', type: icon.mime, purpose: 'any' }, { src: '/app-icon', sizes: '192x192', type: icon.mime, purpose: 'any' }]
      : [{ src: '/kiosk/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }));
});

const staticOpts = { index: 'index.html', dotfiles: 'deny', redirect: true, maxAge: 0 };
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), staticOpts));
app.use('/kiosk', express.static(path.join(__dirname, 'public', 'kiosk'), staticOpts));
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared'), staticOpts));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use((req, res) => res.status(404).type('text/plain').send('Não encontrado'));

// Tratamento de erros: nunca devolve stack trace nem detalhes internos ao cliente.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Conteúdo grande demais.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err.status === 404 || err.code === 'ENOENT') return res.status(404).end();
  console.error(new Date().toISOString(), req.method, req.path, err);
  res.status(500).json({ error: 'Erro interno.' });
});

if (require.main === module) {
  // Limpeza periódica de sessões expiradas e códigos de pareamento vencidos.
  setInterval(() => {
    run('DELETE FROM sessions WHERE created_at < ? OR last_seen_at < ?', Date.now() - 12 * 3_600_000, Date.now() - 2 * 3_600_000);
    run('UPDATE devices SET pair_code_hash = NULL WHERE pair_expires_at < ?', Date.now());
  }, 10 * 60_000).unref();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`Pesquisa de satisfação rodando em http://${host}:${port}  (painel: /admin  •  tablet: /kiosk)`));
}

module.exports = app;
