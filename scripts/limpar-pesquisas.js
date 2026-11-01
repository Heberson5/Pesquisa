'use strict';
// Limpeza das pesquisas antigas (depois da nova pesquisa principal estar no ar). Sem --aplicar só lista, sem gravar.
// Entram só pesquisas principais criadas ANTES de --before (os momentos seguem a principal). Se algum momento foi criado em --before ou depois,
// a principal inteira é pulada com aviso, para não apagar um momento novo sem ele estar na lista.
//   apagada:   sem respostas, sem período no ar/pendente e sem período encerrado nos últimos 30 dias (vai com períodos e momentos);
//   arquivada: com respostas ou período recente; sai da lista e de novos usos, e as respostas ficam;
//   intacta:   padrão de uma filial, ou com período no ar/pendente (arquivar pararia a pesquisa sem aviso). O script avisa.
// Respostas nunca são apagadas: a contagem antes e depois é conferida.
//
// Uso:
//   node scripts/limpar-pesquisas.js --before=2026-11-01T12:00                        → só lista
//   node scripts/limpar-pesquisas.js --before=2026-11-01T12:00 --aplicar=12,15,18     → aplica nos ids confirmados
// --before é AAAA-MM-DDTHH:mm no fuso da empresa.
const { get, all, tx, audit } = require('../src/db');
const { parseLocal } = require('../src/time');
const { familyIds, canDelete, canArchive, deleteFamily, archiveFamily } = require('../src/surveys');

const arg = (n) => { const a = process.argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`)); return a === undefined ? undefined : (a.split('=')[1] ?? ''); };
const fail = (msg) => { console.error(msg + ' Nada foi gravado.'); process.exit(1); };

const before = parseLocal(arg('before'), undefined);
if (before === null) fail('Informe --before=AAAA-MM-DDTHH:mm (data e hora válidas, no fuso da empresa).');
const applyArg = arg('aplicar');
let confirmed = null;
if (applyArg !== undefined) {
  const parts = applyArg.split(',').map((x) => x.trim());
  if (!parts.length || !parts.every((x) => /^[1-9]\d*$/.test(x))) fail('--aplicar deve ser uma lista de ids numéricos separados por vírgula.');
  confirmed = [...new Set(parts.map(Number))];
}

const countResponses = () => get('SELECT COUNT(*) AS n FROM responses').n;
const marks = (ids) => ids.map(() => '?').join(',');

// Decide a ação para uma pesquisa principal elegível.
function decide(sid) {
  const ids = familyIds(sid);
  const fresh = newMoments(sid);
  if (fresh.length) return { action: 'pular', why: `tem momento criado em --before ou depois (${fresh.map((m) => m.id).join(', ')}); revise antes` };
  if (get(`SELECT 1 FROM branches WHERE survey_id IN (${marks(ids)}) LIMIT 1`, ...ids)) return { action: 'pular', why: 'é a pesquisa padrão de uma filial; troque o padrão da filial antes' };
  if (canDelete(sid).ok) return { action: 'apagar', why: 'sem respostas e sem período recente' };
  if (canArchive(sid).ok) return { action: 'arquivar', why: 'tem respostas ou período encerrado há menos de 30 dias' };
  return { action: 'pular', why: 'tem período no ar ou pendente; exclua os agendamentos antes' };
}

const candidates = all('SELECT id, title FROM surveys WHERE parent_id IS NULL AND archived_at IS NULL AND created_at < ? ORDER BY id', before);
const eligible = new Map(candidates.map((s) => [s.id, s]));
const momentsOf = (sid) => all('SELECT id, title, created_at FROM surveys WHERE parent_id = ? ORDER BY id', sid);
const newMoments = (sid) => momentsOf(sid).filter((m) => m.created_at >= before);

if (confirmed === null) {
  console.log('id\ttítulo\trespostas\tagendamentos\tação\tmotivo');
  for (const s of candidates) {
    const ids = familyIds(s.id);
    const resp = get(`SELECT COUNT(*) AS n FROM responses WHERE survey_id IN (${marks(ids)})`, ...ids).n;
    const sch = get(`SELECT COUNT(*) AS n FROM schedules WHERE survey_id IN (${marks(ids)})`, ...ids).n;
    const d = decide(s.id);
    console.log(`${s.id}\t${s.title}\t${resp}\t${sch}\t${d.action}\t${d.why}`);
    for (const m of momentsOf(s.id)) console.log(`  momento ${m.id}\t${m.title}${m.created_at >= before ? '\t(criado em --before ou depois)' : ''}`);
  }
  console.log(`\nNada foi gravado. Para aplicar: --aplicar=<ids confirmados> (respostas hoje: ${countResponses()}).`);
  process.exit(0);
}

const totalBefore = countResponses();
const done = { apagar: 0, arquivar: 0, pular: 0 };
for (const sid of confirmed) {
  const s = eligible.get(sid);
  if (!s) { console.warn(`AVISO ${sid}: não é uma pesquisa principal ativa criada antes de --before; não foi tocada.`); done.pular++; continue; }
  try {
    const result = tx(() => {
      const d = decide(sid); // decide de novo dentro da transação, sobre o estado atual
      const moments = familyIds(sid).length - 1;
      if (d.action === 'apagar') deleteFamily(sid);
      else if (d.action === 'arquivar') archiveFamily(sid);
      else return d;
      audit(null, d.action === 'apagar' ? 'survey.delete' : 'survey.archive', { id: sid, title: s.title, moments, via: 'limpar-pesquisas' }, null);
      return d;
    });
    if (result.action === 'pular') console.warn(`AVISO ${sid} "${s.title}": não foi tocada; ${result.why}.`);
    else console.log(`${sid} "${s.title}": ${result.action === 'apagar' ? 'apagada' : 'arquivada'} (${result.why}).`);
    done[result.action]++;
  } catch (e) {
    console.error(`ERRO ${sid} "${s.title}": ${e.message}; nada foi alterado nesta pesquisa.`);
    process.exitCode = 1;
  }
}
const totalAfter = countResponses();
console.log(`\nApagadas: ${done.apagar}; arquivadas: ${done.arquivar}; puladas: ${done.pular}.`);
console.log(`Total de respostas antes: ${totalBefore}; depois: ${totalAfter}.`);
if (totalAfter < totalBefore) { console.error('ERRO: a contagem de respostas diminuiu. Restaure o backup e investigue.'); process.exit(1); }
if (totalAfter > totalBefore) console.log(`Chegaram ${totalAfter - totalBefore} resposta(s) durante a execução (tablets enviando); nenhuma foi apagada.`);
