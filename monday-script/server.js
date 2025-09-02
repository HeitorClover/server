// server.js — webhook handler para parar timers de subitems quando o status mudar
// Única variável externa esperada: MONDAY_API_KEY
// Porta padrão: process.env.PORT || 1000

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// --- CONFIG (apenas a API key fora do código) ---
const API_KEY = process.env.MONDAY_API_KEY;
if (!API_KEY) {
  console.error('ERRO: MONDAY_API_KEY não definido nas variáveis de ambiente. Defina MONDAY_API_KEY e reinicie.');
  process.exit(1);
}

// Identificador de boot (útil para confirmar novo deploy)
const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

// Colunas corretas (títulos) — mantidos no código conforme solicitado
const TIMER_COL_TITLE = 'Tempo em Controle';
const DATE_COL_TITLE = 'Data de termino';

// Se quiser alterar os status aceitos, altere aqui (mantido no código)
const ACCEPT = ['prospecção', 'abertura de conta', 'montagem de dossiê', 'desistente/inativo'];

// banner startup
console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`PID: ${process.pid}`);
console.log('--------------------------------------------');

// ---------- helper GraphQL (monday) ----------
async function gql(query) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query })
  });
  const data = await r.json().catch(e => {
    console.error('Erro parseando resposta JSON do monday:', e);
    throw e;
  });

  if (data.errors) {
    console.warn('>> GraphQL ERROS DETECTADOS:', JSON.stringify(data.errors, null, 2));
    // Não lançar sempre — deixa chamada chamadora decidir. Aqui lançamos pra facilitar debug.
    throw new Error('GraphQL error: ' + JSON.stringify(data.errors));
  }
  return data.data;
}

// Pega subitens
async function getSubitemsOfItem(itemId) {
  const q = `query { items(ids: ${itemId}) { id subitems { id name } } }`;
  console.log(`> Query subitems do item ${itemId}`);
  const data = await gql(q);
  return data.items?.[0]?.subitems || [];
}

// Busca board + colunas do subitem
async function getSubitemBoardAndColumns(subitemId) {
  const q = `query {
    items(ids: ${subitemId}) {
      id
      board {
        id
        name
        columns { id title type settings_str }
      }
    }
  }`;
  console.log(`> Query board+columns do subitem ${subitemId}`);
  const data = await gql(q);
  console.log('> resposta board+columns (raw):', JSON.stringify(data, null, 2));
  const item = data.items?.[0];
  if (!item || !item.board) throw new Error(`Não achei board para subitem ${subitemId}`);
  return { boardId: item.board.id, cols: item.board.columns || [] };
}

// Encontra coluna pelo título (case-insensitive) e tenta vários tipos para timer
function findColumn(cols, title, expectedType) {
  console.log(`> Procurando coluna: title="${title}" expectedType="${expectedType}"`);
  if (!Array.isArray(cols)) return null;
  for (const c of cols) {
    console.log('> Coluna disponível:', { id: c.id, title: c.title, type: c.type });
    if ((c.title || '').toLowerCase() === (title || '').toLowerCase()) {
      console.log(`> Encontrada coluna por título: id=${c.id} title="${c.title}" type=${c.type}`);
      return c;
    }
  }
  // fallback por tipo (quando título difere)
  if (expectedType) {
    const byType = cols.find(c => (c.type || '').toLowerCase().includes(String(expectedType || '').toLowerCase()));
    if (byType) {
      console.log(`> Encontrada coluna por tipo fallback: id=${byType.id} title="${byType.title}" type=${byType.type}`);
      return byType;
    }
  }
  // fallback por substring no título
  const bySub = cols.find(c => (c.title || '').toLowerCase().includes((title || '').toLowerCase()));
  if (bySub) {
    console.log(`> Encontrada coluna por substring no título: id=${bySub.id} title="${bySub.title}" type=${bySub.type}`);
    return bySub;
  }
  console.log(`> NÃO encontrou coluna title="${title}" type="${expectedType}"`);
  return null;
}

// stop_time_tracking — mutation oficial para parar controle de tempo
async function stopTimer(subitemId, columnId) {
  console.log(`> Chamando stop_time_tracking -> subitem ${subitemId}, column ${columnId}`);
  const mutation = `
    mutation {
      stop_time_tracking(item_id: ${subitemId}, column_id: "${columnId}") {
        id
      }
    }
  `;
  try {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    const json = await res.json();
    console.log(`> stop_time_tracking result for ${subitemId}:`, JSON.stringify(json, null, 2));
    return json;
  } catch (err) {
    console.error(`> Erro chamando stop_time_tracking para ${subitemId}:`, err && err.message ? err.message : err);
    throw err;
  }
}

// Seta data para hoje (YYYY-MM-DD)
async function setTodayDate(subitemId, boardId, columnId) {
  const today = new Date().toISOString().split('T')[0];
  console.log(`> setTodayDate -> subitem ${subitemId}, date ${today}, board ${boardId}, column ${columnId}`);
  const mutation = `mutation {
    change_column_value(
      board_id: ${boardId},
      item_id: ${subitemId},
      column_id: "${columnId}",
      value: "{\\"date\\":\\"${today}\\"}"
    ) { id }
  }`;
  try {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    const json = await res.json();
    console.log(`> setTodayDate result for ${subitemId}:`, JSON.stringify(json, null, 2));
    return json;
  } catch (err) {
    console.error(`> Erro ao setar data para ${subitemId}:`, err && err.message ? err.message : err);
    throw err;
  }
}

// Processa evento (webhook)
async function processEvent(body) {
  console.log('--- processEvent body:', JSON.stringify(body, null, 2));
  const ev = body.event || {};

  // tentar extrair status de várias formas
  let statusText = '';
  try {
    statusText = ev.value?.label?.text || ev.value?.label || ev.columnTitle || ev.column_title || ev.payload?.value?.label || '';
  } catch (e) {
    statusText = '';
  }
  statusText = String(statusText || '').trim();
  console.log('> status extraído:', statusText, 'BOOT_ID:', BOOT_ID);

  if (!statusText) {
    console.log('> Nenhum status extraído — saindo (filtro ativo).');
    return;
  }

  // comparando em lowercase
  if (!ACCEPT.map(s => s.toLowerCase()).includes(statusText.toLowerCase())) {
    console.log(`> Status "${statusText}" não é aceito — ignorando.`);
    return;
  }

  // identificar itemId de várias possíveis chaves
  const candidates = [
    ev.pulseId, ev.pulse_id, ev.itemId, ev.item_id,
    body.pulseId, body.pulse_id, body.itemId, body.item_id,
    body.event?.itemId, body.event?.item_id, ev.payload?.itemId, ev.payload?.item_id
  ];
  const itemId = candidates.find(v => v && /^\d+$/.test(String(v)));
  if (!itemId) {
    console.warn('⚠️ Não encontrei itemId no payload.');
    return;
  }
  console.log('> itemId detectado:', itemId);

  const subitems = await getSubitemsOfItem(Number(itemId));
  console.log(`> Encontrados ${subitems.length} subitems:`, subitems.map(s => ({ id: s.id, name: s.name })));
  if (!subitems || subitems.length === 0) return console.log('> Nenhum subitem — nada a atualizar.');

  for (const s of subitems) {
    try {
      const { boardId, cols } = await getSubitemBoardAndColumns(s.id);

      // localizar coluna de timer (por título; fallback por tipos comuns)
      let timerCol = findColumn(cols, TIMER_COL_TITLE, 'time_tracking');
      if (!timerCol) timerCol = findColumn(cols, TIMER_COL_TITLE, 'duration');
      if (!timerCol) timerCol = findColumn(cols, TIMER_COL_TITLE, 'timer');

      // localizar coluna de data
      const dateCol = findColumn(cols, DATE_COL_TITLE, 'date');

      if (!timerCol) console.warn(`> Coluna de timer "${TIMER_COL_TITLE}" não encontrada para subitem ${s.id}`);
      if (!dateCol) console.warn(`> Coluna de data "${DATE_COL_TITLE}" não encontrada para subitem ${s.id}`);

      // parar timer (usa stop_time_tracking mutation)
      if (timerCol) await stopTimer(s.id, timerCol.id);

      // setar data hoje
      if (dateCol) await setTodayDate(s.id, boardId, dateCol.id);

      // pequeno delay pra evitar flood
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      console.error(`> Erro ao processar subitem ${s.id}:`, err && err.message ? err.message : err);
    }
  }

  console.log('> processEvent concluído. BOOT_ID:', BOOT_ID);
}

// Rota webhook
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  if (body.challenge) {
    // monday exige retorno do challenge ao criar webhook
    return res.status(200).json({ challenge: body.challenge });
  }
  // responder rápido e processar em background
  res.status(200).json({ ok: true, boot: BOOT_ID });
  processEvent(body).catch(err => console.error('processEvent erro:', err));
});

// Health + root friendly
app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));
app.get('/health', (_req, res) => res.json({ status: 'ok', now: new Date().toISOString(), boot_id: BOOT_ID }));

// Porta: usa PORT do ambiente se houver (Render), senão 1000 por padrão
const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
