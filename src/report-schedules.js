'use strict';
// Envio programado do PowerPoint: periodicidade, horário, período coberto e canais.
const { get, all, run, audit } = require('./db');
const { bad, HttpError, id, str, int } = require('./validate');
const { getSettings, saveSettings, emailList } = require('./settings');
const delivery = require('./delivery');
const { queueEmail, renderEmail, queueWhatsAppFile } = require('./notify');
const wa = require('./wa');
const zones = require('./zones');
const { timezone, publicUrl } = require('./config');

const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const CHANNELS = { email: 'E-mail', wa_qr: 'WhatsApp (QR Code)', wa_api: 'WhatsApp (API oficial)' };
const MIGRATED_KEY = 'state.weeklyMigrated';

// Só o que está funcionando agora aparece para escolha.
function activeChannels() {
  const out = [];
  if (delivery.smtp()) out.push('email');
  if (wa.isConnected()) out.push('wa_qr');
  if (delivery.whatsapp() && getSettings().alerts.whatsappReportTemplate) out.push('wa_api');
  return out.map((key) => ({ key, label: CHANNELS[key] }));
}

function input(body, keepChannels = []) {
  const frequency = String(body?.frequency);
  if (!FREQUENCIES.includes(frequency)) throw bad('Periodicidade inválida.');
  const periodMode = body?.periodMode === 'days' ? 'days' : 'previous';
  const channels = Array.isArray(body?.channels) ? [...new Set(body.channels.map(String))] : [];
  if (!channels.length) throw bad('Escolha ao menos um canal.');
  const active = activeChannels().map((c) => c.key);
  for (const c of channels) {
    if (!Object.hasOwn(CHANNELS, c)) throw bad('Canal inválido.');
    if (!active.includes(c) && !keepChannels.includes(c)) throw bad(`O canal "${CHANNELS[c]}" não está ativo.`);
  }
  const phones = (Array.isArray(body?.extraPhones) ? body.extraPhones : []).map((p) => {
    const n = wa.normalizePhone(p);
    if (!n) throw bad(`Telefone inválido: ${String(p).slice(0, 30)}`);
    return n;
  });
  const branchId = body?.branchId ? id(body.branchId, 'filial') : null;
  if (branchId && !get('SELECT 1 FROM branches WHERE id = ?', branchId)) throw bad('Filial inválida.');
  return {
    name: str(body?.name, { field: 'nome', min: 2, max: 80 }), active: body?.active === false ? 0 : 1, frequency,
    weekday: int(body?.weekday ?? 1, { field: 'dia da semana', min: 0, max: 6 }),
    day_of_month: int(body?.dayOfMonth ?? 1, { field: 'dia do mês', min: 1, max: 31 }),
    hour: int(body?.hour ?? 8, { field: 'hora', min: 0, max: 23 }), minute: int(body?.minute ?? 0, { field: 'minuto', min: 0, max: 59 }),
    period_mode: periodMode, period_days: int(body?.periodDays ?? 7, { field: 'dias do período', min: 1, max: 366 }),
    branch_id: branchId, channels: JSON.stringify(channels),
    extra_emails: JSON.stringify(emailList(Array.isArray(body?.extraEmails) ? body.extraEmails : [])), extra_phones: JSON.stringify([...new Set(phones)].slice(0, 20)),
  };
}

function view(s) {
  return { ...s, active: !!s.active, channels: JSON.parse(s.channels), extra_emails: JSON.parse(s.extra_emails), extra_phones: JSON.parse(s.extra_phones),
    branch: s.branch_id ? get('SELECT name FROM branches WHERE id = ?', s.branch_id)?.name : null };
}
const list = () => all('SELECT * FROM report_schedules ORDER BY id').map(view);

function create(body, userId) {
  const v = input(body);
  const r = run(`INSERT INTO report_schedules (name, active, frequency, weekday, day_of_month, hour, minute, period_mode, period_days, branch_id, channels, extra_emails, extra_phones, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, v.name, v.active, v.frequency, v.weekday, v.day_of_month, v.hour, v.minute, v.period_mode, v.period_days, v.branch_id, v.channels, v.extra_emails, v.extra_phones, userId, Date.now());
  return Number(r.lastInsertRowid);
}
function load(sid) {
  const s = get('SELECT * FROM report_schedules WHERE id = ?', sid);
  if (!s) throw new HttpError(404, 'Programação não encontrada.');
  return s;
}
function update(sid, body) {
  const cur = load(sid);
  const v = input(body, JSON.parse(cur.channels));
  run(`UPDATE report_schedules SET name=?, active=?, frequency=?, weekday=?, day_of_month=?, hour=?, minute=?, period_mode=?, period_days=?, branch_id=?, channels=?, extra_emails=?, extra_phones=? WHERE id=?`,
    v.name, v.active, v.frequency, v.weekday, v.day_of_month, v.hour, v.minute, v.period_mode, v.period_days, v.branch_id, v.channels, v.extra_emails, v.extra_phones, sid);
}

function scheduleZone(s) {
  if (!s.branch_id) return timezone;
  return zones.forBranch(get('SELECT id, timezone FROM branches WHERE id = ?', s.branch_id));
}
function localParts(at, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: +p.hour * 60 + +p.minute, year: +p.year, month: +p.month, day: +p.day, date: `${p.year}-${p.month}-${p.day}` };
}

function isDue(s, now = Date.now()) {
  if (!s.active) return false;
  const p = localParts(now, scheduleZone(s));
  if (s.last_run_key === p.date || p.hm < s.hour * 60 + s.minute) return false;
  if (s.frequency === 'weekly') return p.weekday === s.weekday;
  if (s.frequency === 'monthly') return p.day === Math.min(s.day_of_month, new Date(Date.UTC(p.year, p.month, 0)).getUTCDate()); // dia 31 em mês curto: último dia
  return true;
}

// Período do relatório, sem o dia atual, que ainda não terminou.
function periodFor(s, date) {
  const shift = (d, days) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };
  const to = shift(date, -1);
  if (s.period_mode === 'days') return { from: shift(date, -s.period_days), to };
  if (s.frequency === 'daily') return { from: to, to };
  if (s.frequency === 'weekly') return { from: shift(date, -7), to };
  const first = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  const lastPrev = new Date(first); lastPrev.setUTCDate(0);
  return { from: `${lastPrev.toISOString().slice(0, 7)}-01`, to: lastPrev.toISOString().slice(0, 10) };
}

function recordFailure(channel, recipient, reason) {
  run(`INSERT INTO outbox (kind, channel, recipient, status, last_error, attempts, next_attempt_at, created_at) VALUES ('report', ?, ?, 'failed', ?, 1, ?, ?)`, channel, recipient, reason, Date.now(), Date.now());
}

async function runSchedule(s, now = Date.now()) {
  const { reportFor } = require('./stats');
  const settings = getSettings();
  const date = localParts(now, scheduleZone(s)).date;
  run('UPDATE report_schedules SET last_run_key = ?, last_run_at = ? WHERE id = ?', date, now, s.id);
  const period = periodFor(s, date);
  const channels = JSON.parse(s.channels);
  const query = { ...period, ...(s.branch_id ? { branchId: String(s.branch_id) } : {}) };
  const adminScope = { id: 0, role: 'admin', name: 'Relatório automático' };

  // Cada usuário recebe o relatório no escopo dele; contatos extras recebem o relatório da programação.
  const users = all('SELECT id, name, email, role, whatsapp FROM users WHERE active = 1 AND notify_reports = 1').filter((u) => {
    if (u.role === 'admin') return true;
    return s.branch_id ? !!get('SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ?', u.id, s.branch_id) : !!get('SELECT 1 FROM user_branches WHERE user_id = ?', u.id);
  });
  const targets = [...users.map((u) => ({ user: u, email: u.email, phone: u.whatsapp })),
    ...JSON.parse(s.extra_emails).map((email) => ({ user: adminScope, email, phone: null })), ...JSON.parse(s.extra_phones).map((phone) => ({ user: adminScope, email: null, phone }))];

  const label = `${period.from.split('-').reverse().join('/')} a ${period.to.split('-').reverse().join('/')}`;
  const caption = `${settings.companyName}: relatório de satisfação de ${label}.`;
  const fileName = `relatorio-nps-${period.to}.pptx`;
  const cache = new Map();
  const build = async (u) => {
    const key = u.role === 'admin' ? 'admin' : u.id;
    if (!cache.has(key)) cache.set(key, await reportFor(u, query, 'Relatório automático'));
    return cache.get(key).buffer;
  };
  const mailOk = !!delivery.smtp();
  const apiOk = !!(delivery.whatsapp() && settings.alerts.whatsappReportTemplate);
  let queued = 0;
  for (const t of targets) {
    if (t.email && channels.includes('email')) {
      if (!mailOk) { recordFailure('email', t.email, 'E-mail não configurado'); continue; }
      const { html, text } = renderEmail({ brand: settings, title: s.name, intro: `Período: ${label}. O relatório completo em PowerPoint está anexado.`, rows: [], button: { label: 'Abrir o painel', url: `${publicUrl}/admin/` }, footer: 'Para deixar de receber, desmarque os relatórios em Minha conta.' });
      if (queueEmail({ to: t.email, subject: `${settings.companyName}: ${s.name}`, text, html, kind: 'report', attachment: await build(t.user), attachmentName: fileName })) queued++;
    }
    if (t.phone && channels.includes('wa_qr')) {
      const buffer = await build(t.user);
      wa.queue({ kind: 'report', recipient: t.phone, body: caption, filePath: wa.saveFile(buffer), fileName, branchId: s.branch_id, force: true });
      queued++;
    }
    if (t.phone && channels.includes('wa_api')) {
      if (!apiOk) { recordFailure('whatsapp', t.phone, 'API oficial sem modelo de relatório configurado'); continue; }
      queueWhatsAppFile(t.phone, { template: settings.alerts.whatsappReportTemplate, language: settings.alerts.whatsappLanguage, params: [label] }, await build(t.user), fileName, 'report');
      queued++;
    }
  }
  audit(null, 'report.schedule_run', { id: s.id, name: s.name, period, queued }, null);
  return { queued, period };
}

// O relatório semanal antigo vira uma programação, com os mesmos dia, hora e destinatários.
function migrateWeekly() {
  if (get('SELECT 1 FROM settings WHERE key = ?', MIGRATED_KEY)) return;
  const w = getSettings().weeklyReport;
  if (w.enabled) {
    run(`INSERT INTO report_schedules (name, active, frequency, weekday, day_of_month, hour, minute, period_mode, period_days, channels, extra_emails, extra_phones, created_at)
      VALUES ('Relatório semanal', 1, 'weekly', ?, 1, ?, 0, 'previous', 7, '["email"]', ?, '[]', ?)`, w.weekday, w.hour, JSON.stringify(w.extraEmails), Date.now());
    saveSettings({ weeklyReport: { enabled: false } });
  }
  run("INSERT INTO settings (key, value) VALUES (?, 'true')", MIGRATED_KEY);
}

async function runDue(now = Date.now()) {
  migrateWeekly();
  let n = 0;
  for (const s of all('SELECT * FROM report_schedules WHERE active = 1')) {
    if (!isDue(s, now)) continue;
    await runSchedule(s, now);
    n++;
  }
  return n;
}

module.exports = { CHANNELS, activeChannels, list, create, update, load, isDue, periodFor, runSchedule, runDue, migrateWeekly };
