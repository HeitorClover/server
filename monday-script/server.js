// server.js — versão final ajustada para parar timer e setar data
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// CONFIG - sua API key
const API_KEY = process.env.MONDAY_API_KEY;

// Colunas corretas
const TIMER_COL_TITLE = 'Tempo em Controle';
const DATE_COL_TITLE = 'Data de termino';

// helper GraphQL
async function gql(query) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query })
  });
  const data = await r.json();
  if (data.errors) {
    console.error('>> GraphQL ERROS DETECTADOS:', JSON.stringify(data.errors, null, 2));
    throw new Error('GraphQL error: ' + JSON.stringify(data.errors));
  }
  return data.data;
}

// Pega subitens
async function getSubitemsOfItem(itemId) {
  const q = `query { items(ids: ${itemId}) { id subitems { id name } } }`;
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
  const data = await gql(q);
  const item = data.items?.[0];
  if (!item || !item.board) throw new Error(`Não achei board para subitem ${subitemId}`);
  return { boardId: item.board.id, cols: item.board.columns || [] };
}

// Encontra coluna pelo título e tipo, com log detalhado
function findColumn(cols, title, type) {
  console.log('> Procurando coluna:', title, 'do tipo:', type);
  if (!Array.isArray(cols)) return null;
  for (const c of cols) {
    console.log('> Coluna disponível:', c.title, c.type);
    if ((c.title || '').toLowerCase() === (title || '').toLowerCase() && c.type === type) return c;
  }
  return null;
}

// Para o timer
async function stopTimer(subitemId, boardId, columnId) {
  const mutation = `mutation {
    change_column_value(
      board_id: ${boardId},
      item_id: ${subitemId},
      column_id: "${columnId}",
      value: "{\\"paused\\":true}"
    ) { id }
  }`;
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query: mutation })
  });
  const json = await res.json();
  console.log(`> Stop timer subitem ${subitemId}:`, JSON.stringify(json, null, 2));
}

// Seta data para hoje
async function setTodayDate(subitemId, boardId, columnId) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const mutation = `mutation {
    change_column_value(
      board_id: ${boardId},
      item_id: ${subitemId},
      column_id: "${columnId}",
      value: "{\\"date\\":\\"${today}\\"}"
    ) { id }
  }`;
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query: mutation })
  });
  const json = await res.json();
  console.log(`> Set date subitem ${subitemId}:`, JSON.stringify(json, null, 2));
}

// Processa evento
async function processEvent(body) {
  const ev = body.event || {};
  let statusText = ev.value?.label?.text || ev.columnTitle || '';
  statusText = String(statusText || '').trim();
  console.log('> status extraído:', statusText);

  const ACCEPT = ['prospecção', 'abertura de conta', 'montagem de dossiê', 'desistente/inativo'];
  if (!ACCEPT.includes(statusText.toLowerCase())) {
    console.log(`> Status "${statusText}" não é aceito — ignorando.`);
    return;
  }

  const candidates = [
    ev.pulseId, ev.pulse_id, ev.itemId, ev.item_id,
    body.pulseId, body.pulse_id, body.itemId, body.item_id,
    body.event?.itemId, body.event?.item_id
  ];
  const itemId = candidates.find(v => v && /^\d+$/.test(String(v)));
  if (!itemId) return console.warn('⚠️ Não encontrei itemId no payload.');

  const subitems = await getSubitemsOfItem(Number(itemId));
  if (subitems.length === 0) return console.log('> Nenhum subitem — nada a atualizar.');

  for (const s of subitems) {
    try {
      const { boardId, cols } = await getSubitemBoardAndColumns(s.id);
      const timerCol = findColumn(cols, TIMER_COL_TITLE, 'time_tracking');
      const dateCol = findColumn(cols, DATE_COL_TITLE, 'date');

      if (!timerCol) console.warn(`> Coluna de timer "${TIMER_COL_TITLE}" não encontrada para subitem ${s.id}`);
      if (!dateCol) console.warn(`> Coluna de data "${DATE_COL_TITLE}" não encontrada para subitem ${s.id}`);

      if (timerCol) await stopTimer(s.id, boardId, timerCol.id);
      if (dateCol) await setTodayDate(s.id, boardId, dateCol.id);
    } catch (err) {
      console.error(`> Erro ao processar subitem ${s.id}:`, err.message || err);
    }
  }
}

// Rota webhook
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });
  res.sendStatus(200);
  processEvent(body).catch(err => console.error('processEvent erro:', err));
});

app.get('/webhook', (_req, res) => res.send('Webhook ativo 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
