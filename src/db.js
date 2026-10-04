'use strict';
// Camada de banco de dados. Usa o SQLite embutido do Node (node:sqlite).
// Todas as consultas usam parâmetros (?) — nunca concatenação de strings.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { DATA_DIR } = require('./config');

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'pesquisa.db');
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','gestor')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  city TEXT,
  survey_id INTEGER REFERENCES surveys(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_branches (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  welcome_title TEXT NOT NULL,
  welcome_text TEXT,
  thanks_title TEXT NOT NULL,
  thanks_text TEXT,
  thanks_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  thanks_seconds INTEGER NOT NULL DEFAULT 8,
  idle_seconds INTEGER NOT NULL DEFAULT 45,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  help_text TEXT,
  type TEXT NOT NULL CHECK (type IN ('nps','scale5','single','multi','yesno','text')),
  required INTEGER NOT NULL DEFAULT 1,
  is_nps INTEGER NOT NULL DEFAULT 0 CHECK (is_nps = 0 OR type = 'nps'),
  options_json TEXT,
  display TEXT NOT NULL DEFAULT 'default' CHECK (display IN ('default','numbers','faces','icons')),
  icon TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  pair_code_hash TEXT,
  pair_expires_at INTEGER,
  paired_at INTEGER,
  last_seen_at INTEGER,
  last_ip TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  survey_id INTEGER NOT NULL REFERENCES surveys(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  started_at INTEGER,
  submitted_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_branch_time ON responses(branch_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_responses_survey_time ON responses(survey_id, submitted_at);
CREATE TABLE IF NOT EXISTS answers (
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  value_num INTEGER,
  value_text TEXT,
  PRIMARY KEY (response_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
`;
db.exec(SCHEMA);

// Migrações simples para bancos criados por versões anteriores.
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing('questions', 'display', "display TEXT NOT NULL DEFAULT 'default' CHECK (display IN ('default','numbers','faces','icons'))");
addColumnIfMissing('questions', 'icon', 'icon TEXT');

// ---- versão 3: 2FA, recuperação de senha, e-mails, contato (LGPD), casos, metas, agendamento,
//      link/QR por filial, idiomas, condicionais, horário de funcionamento e alertas.
db.exec(`
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','webhook','whatsapp')),
  recipient TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  payload TEXT,
  attachment BLOB,
  attachment_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  response_id INTEGER NOT NULL UNIQUE REFERENCES responses(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  min_score INTEGER,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','em_contato','resolvido','sem_retorno')),
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cases_branch_status ON cases(branch_id, status);
CREATE TABLE IF NOT EXISTS case_notes (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at INTEGER NOT NULL,
  text TEXT,
  status_from TEXT,
  status_to TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_schedules_time ON schedules(starts_at, ends_at);
CREATE TABLE IF NOT EXISTS link_tickets (
  nonce TEXT PRIMARY KEY,
  branch_id INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  used_at INTEGER
);
`);
for (const [table, column, ddl] of [
  ['users', 'totp_secret_enc', 'totp_secret_enc TEXT'],
  ['users', 'totp_enabled', 'totp_enabled INTEGER NOT NULL DEFAULT 0'],
  ['users', 'totp_last_step', 'totp_last_step INTEGER'],
  ['users', 'notify_detractors', 'notify_detractors INTEGER NOT NULL DEFAULT 1'],
  ['users', 'notify_reports', 'notify_reports INTEGER NOT NULL DEFAULT 1'],
  ['users', 'notify_offline', 'notify_offline INTEGER NOT NULL DEFAULT 1'],
  ['sessions', 'mfa_setup_required', 'mfa_setup_required INTEGER NOT NULL DEFAULT 0'],
  ['responses', 'channel', "channel TEXT NOT NULL DEFAULT 'tablet'"],
  ['responses', 'lang', 'lang TEXT'],
  ['responses', 'contact_name_enc', 'contact_name_enc TEXT'],
  ['responses', 'contact_phone_enc', 'contact_phone_enc TEXT'],
  ['responses', 'contact_email_enc', 'contact_email_enc TEXT'],
  ['responses', 'contact_phone_lookup', 'contact_phone_lookup TEXT'],
  ['responses', 'contact_email_lookup', 'contact_email_lookup TEXT'],
  ['responses', 'contact_consent_at', 'contact_consent_at INTEGER'],
  ['responses', 'anonymized_at', 'anonymized_at INTEGER'],
  ['branches', 'alert_emails', 'alert_emails TEXT'],
  ['branches', 'alert_phones', 'alert_phones TEXT'],
  ['branches', 'nps_goal', 'nps_goal INTEGER'],
  ['branches', 'hours_json', 'hours_json TEXT'],
  ['branches', 'public_enabled', 'public_enabled INTEGER NOT NULL DEFAULT 0'],
  ['branches', 'public_token_enc', 'public_token_enc TEXT'],
  ['branches', 'public_token_hash', 'public_token_hash TEXT'],
  ['devices', 'offline_alerted_at', 'offline_alerted_at INTEGER'],
  ['surveys', 'languages', "languages TEXT NOT NULL DEFAULT '[\"pt\"]'"],
  ['surveys', 'i18n', 'i18n TEXT'],
  ['surveys', 'contact_mode', "contact_mode TEXT NOT NULL DEFAULT 'never'"],
  ['questions', 'show_if', 'show_if TEXT'],
  ['questions', 'i18n', 'i18n TEXT'],
]) addColumnIfMissing(table, column, ddl);
db.exec(`CREATE INDEX IF NOT EXISTS idx_resp_phone ON responses(contact_phone_lookup);
CREATE INDEX IF NOT EXISTS idx_resp_email ON responses(contact_email_lookup);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_public ON branches(public_token_hash);`);

// Bancos de versões anteriores não aceitavam a aparência 'default'. Recria a tabela seguindo o
// procedimento oficial do SQLite (nova tabela → copia → apaga a antiga → renomeia a nova), que mantém
// válidas as referências de `answers` para `questions`.
const qSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'questions'").get().sql;
if (!qSql.includes("'default'")) {
  const createNew = SCHEMA.match(/CREATE TABLE IF NOT EXISTS questions \([\s\S]*?\n\);/)[0]
    .replace('CREATE TABLE IF NOT EXISTS questions', 'CREATE TABLE questions_new');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`${createNew}
      INSERT INTO questions_new (id, survey_id, position, text, help_text, type, required, is_nps, options_json, display, icon)
        SELECT id, survey_id, position, text, help_text, type, required, is_nps, options_json, display, icon FROM questions;
      DROP TABLE questions;
      ALTER TABLE questions_new RENAME TO questions;`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migração de perguntas deixaria referências inválidas.');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function audit(userId, action, detail, ip) {
  run('INSERT INTO audit_log (at, user_id, action, detail, ip) VALUES (?,?,?,?,?)',
    Date.now(), userId ?? null, action, detail ? JSON.stringify(detail).slice(0, 2000) : null, ip ?? null);
}

module.exports = { db, tx, get, all, run, audit, MEDIA_DIR };
