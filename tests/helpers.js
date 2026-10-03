'use strict';
// Sobe o servidor em porta aleatória com banco temporário isolado.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesquisa-test-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.MEDIA_DIR = path.join(dir, 'media');
process.env.TRUST_PROXY = '1'; // permite simular IPs distintos via X-Forwarded-For

const app = require('../server');
const { run, get } = require('../src/db');
const { hashPassword } = require('../src/security');

let server;
let base;
let ipCounter = 1;

async function start() {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
function stop() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }

const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

// Cliente HTTP simples que guarda cookie e CSRF (como um navegador).
class Client {
  constructor(ip = freshIp()) { this.ip = ip; this.cookie = null; this.csrf = null; }
  async req(method, url, { body, headers = {}, raw } = {}) {
    const h = { 'X-Forwarded-For': this.ip, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== 'GET' && !('X-CSRF-Token' in headers)) h['X-CSRF-Token'] = this.csrf;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined && method !== 'GET') { h['Content-Type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, headers: res.headers, text, json, setCookie };
  }
  async login(email, password) {
    const r = await this.req('POST', '/api/admin/login', { body: { email, password } });
    if (r.json?.csrf) this.csrf = r.json.csrf;
    return r;
  }
}

function makeUser(email, role, password = 'SenhaForte123', branches = []) {
  const id = run('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,?,?)', email, email, hashPassword(password), role, Date.now()).lastInsertRowid;
  for (const b of branches) run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', id, b);
  return Number(id);
}

module.exports = { start, stop, Client, makeUser, freshIp, run, get, base: () => base };
