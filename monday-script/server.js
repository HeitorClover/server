// server.js
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const API_KEY = process.env.MONDAY_API_KEY;
if (!API_KEY) {
  console.error('ERRO: MONDAY_API_KEY não definido nas variáveis de ambiente. Defina MONDAY_API_KEY e reinicie.');
  process.exit(1);
}

const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

// Coluna de data
const DATE_COL_TITLE = 'FINALIZAÇÃO';

// Status aceitos (já existentes + novos das imagens)
const ACCEPT = [
  'abrir conta','comercial','documentos','caixaaqui','doc pendente','assinatura','restrição',
  'conformidade','avaliação','conta ativa','desist/demora','aprovado','condicionado','reprovado',
  'analise','engenharia','projetos','pago','não pago','projetos','escritura','ab matricula','alvará',
  'pci','o.s concluida','proj aprovado','engenharia','unificação','desmembramento'
];

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`PID: ${process.pid}`);
console.log('--------------------------------------------');

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

// Busca colunas do subitem
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
  const item = data.items?.[0];
  if (!item || !item.board) throw new Error(`Não achei board para subitem ${subitemId}`);
  return { boardId: item.board.id, cols: item.board.columns || [] };
}

// Encontra coluna
function findColumn(cols, title, expectedType) {
  if (!Array.isArray(cols)) return null;
  for (const c of cols) {
    if ((c.title || '').toLowerCase() === (title || '').toLowerCase()) return c;
  }
  if (expectedType) {
    const byType = cols.find(c => (c.type || '').toLowerCase().includes(String(expectedType || '').toLowerCase()));
    if (byType) return byType;
  }
  return cols.find(c => (c.title || '').toLowerCase().includes((title || '').toLowerCase())) || null;
}

// Seta data + hora atual na coluna de FINALIZAÇÃO
async function setTodayDate(subitemId, boardId, columnId) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const valueJson = JSON.stringify({ date, time });

  const mutation = `mutation {
    change_column_value(
      board_id: ${boardId},
      item_id: ${subitemId},
      column_id: "${columnId}",
      value: "${valueJson.replace(/"/g, '\\"')}"
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
    console.error(`> Erro ao setar data/hora para ${subitemId}:`, err && err.message ? err.message : err);
    throw err;
  }
}

// Processa webhook
async function processEvent(body) {
  const ev = body.event || {};
  let statusText = '';
  try {
    statusText = ev.value?.label?.text || ev.value?.label || ev.columnTitle || ev.column_title || ev.payload?.value?.label || '';
  } catch (e) { statusText = ''; }
  statusText = String(statusText || '').trim();
  if (!statusText) return;

  if (!ACCEPT.map(s => s.toLowerCase()).includes(statusText.toLowerCase())) return;

  const candidates = [
    ev.pulseId, ev.pulse_id, ev.itemId, ev.item_id,
    body.pulseId, body.pulse_id, body.itemId, body.item_id,
    body.event?.itemId, body.event?.item_id, ev.payload?.itemId, ev.payload?.item_id
  ];
  const itemId = candidates.find(v => v && /^\d+$/.test(String(v)));
  if (!itemId) return;

  const subitems = await getSubitemsOfItem(Number(itemId));
  if (!subitems || subitems.length === 0) return;

  // Atualiza somente o último subitem
  const lastSubitem = subitems[subitems.length - 1];
  try {
    const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitem.id);
    const dateCol = findColumn(cols, DATE_COL_TITLE, 'date');
    if (!dateCol) return console.warn(`> Coluna de data "${DATE_COL_TITLE}" não encontrada para subitem ${lastSubitem.id}`);
    await setTodayDate(lastSubitem.id, boardId, dateCol.id);
    console.log(`> Data atualizada apenas para o último subitem ${lastSubitem.id}`);
  } catch (err) {
    console.error(`> Erro ao processar subitem ${lastSubitem.id}:`, err && err.message ? err.message : err);
  }
}

// Rota webhook
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });
  res.status(200).json({ ok: true, boot: BOOT_ID });
  processEvent(body).catch(err => console.error('processEvent erro:', err));
});

app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));
app.get('/webhook', (_req, res) => res.json({ status: 'ok', now: new Date().toISOString(), boot_id: BOOT_ID }));

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
