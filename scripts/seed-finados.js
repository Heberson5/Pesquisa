'use strict';
// Cria as pesquisas da programação de Finados 2026 (Memorial Santa Cruz — Tangará da Serra):
// para cada programação, uma pesquisa ANTES do início e outra 1 hora DEPOIS do início — no máximo 2 perguntas cada.
// Seguro para produção e repetível (não duplica pesquisas que já existem).
//
// Uso:
//   npm run seed:finados                                  → só cria as pesquisas
//   npm run seed:finados -- --branch=TGS                  → cria e AGENDA as pesquisas para a filial (código da filial)
//   npm run seed:finados -- --branch=TGS --date=2026-11-02 --antes=15 --depois=30
const { get, all, run, tx } = require('../src/db');
const { parseLocal } = require('../src/time');

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const BRANCH = arg('branch', '');
const DATE = arg('date', '2026-11-02');
const TZ = arg('tz', 'America/Cuiaba');
const MIN_ANTES = Number(arg('antes', 15));    // a pesquisa "antes" fica no ar nos X minutos que antecedem o início
const MIN_DEPOIS = Number(arg('depois', 30));  // a pesquisa "depois" abre 1 hora após o início e dura X minutos

const PROGRAMACAO = [
  { hora: '07:00', rotulo: '7h', nome: 'Missa — Paróquia Nossa Senhora Aparecida', curto: 'a missa' },
  { hora: '09:00', rotulo: '9h', nome: 'Soltura de pipas — Igreja Adventista', curto: 'a soltura de pipas' },
  { hora: '10:30', rotulo: '10h30', nome: 'Momento com a Doutrina Espírita', curto: 'o momento da Doutrina Espírita' },
  { hora: '14:30', rotulo: '14h30', nome: 'Igreja Universal do Reino de Deus', curto: 'a celebração' },
  { hora: '16:00', rotulo: '16h', nome: 'Missa — Paróquia Santa Terezinha', curto: 'a missa' },
];

const nps = (text) => ({ text, type: 'nps', required: 1, is_nps: 1 }); // toda pergunta é nota de 0 a 10 e entra no NPS

function pesquisaAntes(p) {
  return {
    title: `Finados 2026 · ${p.rotulo} · ${p.nome} · Antes`,
    welcome_title: 'Seja bem-vindo(a) ao Memorial Santa Cruz',
    welcome_text: `Em instantes começa ${p.curto}. Conte-nos como foi a sua chegada (2 perguntas rápidas).`,
    thanks_title: 'Obrigado!',
    thanks_text: 'Que seja um dia de fé, memória e união. Estamos à disposição.',
    questions: [
      nps('De 0 a 10, como você avalia a recepção e o acolhimento que recebeu até agora?'),
      nps('De 0 a 10, como você avalia a organização e a sinalização do local para este momento?'),
    ],
  };
}

function pesquisaDepois(p) {
  return {
    title: `Finados 2026 · ${p.rotulo} · ${p.nome} · Depois`,
    welcome_title: 'Sua opinião é muito importante',
    welcome_text: `Conte-nos como foi ${p.curto} (2 perguntas rápidas).`,
    thanks_title: 'Muito obrigado por compartilhar este momento conosco.',
    thanks_text: 'Um dia de fé, memória e união.',
    questions: [
      nps('De 0 a 10, como você avalia a condução e o acolhimento durante este momento?'),
      nps('De 0 a 10, como você avalia a estrutura e a organização do Memorial durante a programação?'),
    ],
  };
}

const lista = [];
for (const p of PROGRAMACAO) { lista.push({ p, tipo: 'antes', def: pesquisaAntes(p) }, { p, tipo: 'depois', def: pesquisaDepois(p) }); }

// Confere a filial antes de gravar qualquer coisa: código errado não pode deixar pesquisas sem agendamento.
const filial = BRANCH ? get('SELECT id, name FROM branches WHERE code = ? COLLATE NOCASE', BRANCH) : null;
if (BRANCH && !filial) { console.error(`Filial com código "${BRANCH}" não encontrada. Nada foi criado.`); process.exit(1); }
const inicios = PROGRAMACAO.map((p) => parseLocal(`${DATE}T${p.hora}`, TZ));
if (BRANCH && inicios.some((t) => t === null)) { console.error('Data inválida (use AAAA-MM-DD). Nada foi criado.'); process.exit(1); }

const ids = {};
let criadas = 0;
let atualizadas = 0;
tx(() => {
  const now = Date.now();
  for (const item of lista) {
    const d = item.def;
    const ja = get('SELECT id FROM surveys WHERE title = ?', d.title);
    if (ja) {
      ids[`${item.p.hora}-${item.tipo}`] = ja.id;
      // Perguntas iguais ficam intactas: recriá-las troca os ids e invalidaria a pesquisa já carregada nos tablets.
      const atuais = all('SELECT text FROM questions WHERE survey_id = ? ORDER BY position', ja.id).map((q) => q.text);
      if (JSON.stringify(atuais) === JSON.stringify(d.questions.map((q) => q.text))) continue;
      // Pesquisa já criada antes: atualiza as perguntas, desde que ainda não tenha respostas.
      if (!get('SELECT 1 FROM responses WHERE survey_id = ? LIMIT 1', ja.id)) {
        run('DELETE FROM questions WHERE survey_id = ?', ja.id);
        d.questions.forEach((q, i) => run('INSERT INTO questions (survey_id, position, text, type, required, is_nps, options_json, display) VALUES (?,?,?,?,?,?,?,?)',
          ja.id, i, q.text, q.type, q.required, q.is_nps || 0, null, 'default'));
        run('UPDATE surveys SET updated_at = ? WHERE id = ?', now, ja.id);
        atualizadas++;
      } else console.log(`"${d.title}" já tem respostas; perguntas mantidas.`);
      continue;
    }
    const id = Number(run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_seconds, idle_seconds, contact_mode, languages, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, d.title, d.welcome_title, d.welcome_text, d.thanks_title, d.thanks_text, 6, 45, 'never', JSON.stringify(['pt']), now, now).lastInsertRowid);
    d.questions.forEach((q, i) => run(`INSERT INTO questions (survey_id, position, text, type, required, is_nps, options_json, display) VALUES (?,?,?,?,?,?,?,?)`,
      id, i, q.text, q.type, q.required, q.is_nps || 0, null, 'default'));
    ids[`${item.p.hora}-${item.tipo}`] = id; criadas++;
  }
});
console.log(`Pesquisas criadas: ${criadas}; perguntas atualizadas: ${atualizadas}.`);

if (BRANCH) {
  const M = 60_000;
  let agendadas = 0;
  tx(() => {
    PROGRAMACAO.forEach((p, i) => {
      const ini = inicios[i];
      const proxAntes = inicios[i + 1] ? inicios[i + 1] - MIN_ANTES * M : Infinity;
      const janelas = [
        ['antes', ini - MIN_ANTES * M, ini],
        ['depois', ini + 60 * M, Math.min(ini + 60 * M + MIN_DEPOIS * M, proxAntes)], // não invade a pesquisa "antes" da programação seguinte
      ];
      for (const [tipo, de, ate] of janelas) {
        if (ate <= de) continue;
        const sid = ids[`${p.hora}-${tipo}`];
        if (get('SELECT 1 FROM schedules WHERE survey_id = ? AND branch_id = ? AND starts_at = ?', sid, filial.id, de)) continue;
        run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)', sid, filial.id, de, ate, Date.now());
        agendadas++;
      }
    });
  });
  console.log(`Agendamentos criados para "${filial.name}" em ${DATE}: ${agendadas}.`);
}
