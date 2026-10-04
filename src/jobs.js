'use strict';
// Tarefas em segundo plano: envio de notificações, alertas, relatórios e limpeza (LGPD).
// Cada tarefa roda isolada: um erro em uma não interrompe as outras.
const { run } = require('./db');
const { processOutbox } = require('./notify');

const jobs = [];
function every(name, ms, fn) { jobs.push({ name, ms, fn, last: 0, running: false }); }

every('outbox', 30_000, () => processOutbox());
every('limpeza-sessoes', 10 * 60_000, () => {
  run('DELETE FROM sessions WHERE created_at < ? OR last_seen_at < ?', Date.now() - 12 * 3_600_000, Date.now() - 2 * 3_600_000);
  run('UPDATE devices SET pair_code_hash = NULL WHERE pair_expires_at < ?', Date.now());
  run('DELETE FROM mfa_challenges WHERE created_at < ?', Date.now() - 10 * 60_000);
  run('DELETE FROM password_resets WHERE expires_at < ?', Date.now() - 86_400_000);
  run('DELETE FROM link_tickets WHERE issued_at < ?', Date.now() - 2 * 3_600_000);
});

async function tick() {
  const now = Date.now();
  for (const j of jobs) {
    if (j.running || now - j.last < j.ms) continue;
    j.running = true; j.last = now;
    try { await j.fn(); } catch (e) { console.error(new Date().toISOString(), `[tarefa ${j.name}]`, e.message); } finally { j.running = false; }
  }
}

function start() {
  const t = setInterval(tick, 15_000);
  t.unref();
  setTimeout(tick, 2_000).unref();
}

module.exports = { start, every, tick };
