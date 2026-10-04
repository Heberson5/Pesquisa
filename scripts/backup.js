'use strict';
// Backup do banco (cópia consistente com VACUUM INTO, sem parar o sistema) e das mídias.
// Uso: node scripts/backup.js          → faz um backup agora
//      node scripts/backup.js --loop   → backup diário às 03:00 (horário da empresa)
// Guarda BACKUP_KEEP_DAYS dias (padrão 14). Destino: BACKUP_DIR (padrão /backups).
const fs = require('node:fs');
const path = require('node:path');
const { db, MEDIA_DIR } = require('../src/db');
const { localNow } = require('../src/time');

const DIR = process.env.BACKUP_DIR || '/backups';
const KEEP_DAYS = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS || 14));

function backupOnce() {
  fs.mkdirSync(path.join(DIR, 'media'), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const file = path.join(DIR, `pesquisa-${stamp}.db`);
  if (!/^[\w/.-]+$/.test(file)) throw new Error('Caminho de backup inválido.');
  db.exec(`VACUUM INTO '${file}'`);
  fs.chmodSync(file, 0o600);
  // Mídias são imutáveis (nome = id aleatório): copia só as novas.
  let copied = 0;
  for (const name of fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR) : []) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    const dest = path.join(DIR, 'media', name);
    if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(MEDIA_DIR, name), dest); copied++; }
  }
  // Retenção
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(DIR)) {
    if (/^pesquisa-\d{8}-\d{6}\.db$/.test(name) && fs.statSync(path.join(DIR, name)).mtimeMs < limit) fs.rmSync(path.join(DIR, name));
  }
  console.log(new Date().toISOString(), `backup ok: ${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB), ${copied} mídia(s) nova(s)`);
}

async function loop() {
  let lastDay = null;
  for (;;) {
    const n = localNow();
    if (n.hour === 3 && lastDay !== n.date) {
      try { backupOnce(); lastDay = n.date; } catch (e) { console.error(new Date().toISOString(), 'FALHA NO BACKUP:', e.message); }
    }
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

if (process.argv.includes('--loop')) { backupOnce(); loop(); } else backupOnce();
