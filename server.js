// server.js — versão com logs completos para debug de mutation e coluna (todos os subitens)
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// CONFIG - coloque sua API key aqui
const API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjU1NDIxMzcyNSwiYWFpIjoxMSwidWlkIjo2OTIyNzMyNywiaWFkIjoiMjAyNS0wOC0yNVQxODowMToxNS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQyODE1NTksInJnbiI6InVzZTEifQ.W0gS5NCcBO5iVEljH3FjccT9vO8evxS2f75Beh6gYdQ';     
const SUBITEM_STATUS_TITLE = 'Controle'; // nome da coluna de status no subitem
const FECHADO_STATUS_INDEX = 1; // índice fixo para "Fechado"

// helper GraphQL (mais verboso em caso de erro)
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

// Pega subitens de um item pai
async function getSubitemsOfItem(itemId) {
  const q = `query { items(ids: ${itemId}) { id subitems { id name } } }`;
  console.log(`> Query subitems do item ${itemId}`);
  const data = await gql(q);
  console.log('> resposta subitems (raw):', JSON.stringify(data, null, 2));
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

// Encontra a coluna de status chamada SUBITEM_STATUS_TITLE (case-insensitive)
function findStatusColumn(cols) {
  if (!Array.isArray(cols)) return null;
  const exact = cols.find(c => (c.title || '').toLowerCase() === (SUBITEM_STATUS_TITLE || '').toLowerCase());
  if (exact) return exact;
  const fallback = cols.find(c => c.type === 'status');
  return fallback || null;
}

// Faz a mutation e retorna o resultado completo (para log)
async function changeSubitemStatusByIndex(subitemId, boardId, columnId, index) {
  const mutation = `
    mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${subitemId},
        column_id: "${columnId}",
        value: "{\\"index\\": ${index}}"
      ) { id }
    }
  `;
  console.log(`> Executando mutation change_column_value (subitem ${subitemId}) -> index ${index}`);
  try {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    const json = await res.json();
    console.log('> mutation result (raw):', JSON.stringify(json, null, 2));
    return json;
  } catch (err) {
    console.error('> Erro ao chamar mutation:', err.message || err);
    throw err;
  }
}

// Processa evento recebido
async function processEvent(body) {
  console.log('--- processEvent body:', JSON.stringify(body, null, 2));
  const ev = body.event || {};

  let statusText = ev.value?.label?.text || ev.columnTitle || ev.groupTitle || '';
  statusText = String(statusText || '').trim();
  console.log(`> status extraído: "${statusText}"`);

  const ACCEPT = ['prospecção', 'abertura de conta', 'montagem de dossiê', 'desistente/inativo'];
  const norm = statusText.toLowerCase();
  if (!ACCEPT.includes(norm)) {
    console.log(`> Status "${statusText}" não é um dos aceitos — ignorando.`);
    return;
  }


  const candidates = [
    ev.pulseId, ev.pulse_id, ev.itemId, ev.item_id,
    body.pulseId, body.pulse_id, body.itemId, body.item_id,
    body.event?.itemId, body.event?.item_id
  ];
  const itemId = candidates.find(v => v && /^\d+$/.test(String(v)));
  if (!itemId) {
    console.warn('⚠️ Não encontrei itemId no payload.');
    return;
  }
  const numericItemId = Number(itemId);
  console.log('> itemId detectado:', numericItemId);

  const subitems = await getSubitemsOfItem(numericItemId);
  console.log(`> Encontrados ${subitems.length} subitems:`, subitems.map(s => ({ id: s.id, name: s.name })));

  if (subitems.length === 0) {
    console.log('> Nenhum subitem — nada a atualizar.');
    return;
  }

  // Atualizar todos os subitens
  let subsToUpdate = subitems;
  console.log('> subitens que serão atualizados:', subsToUpdate.map(s => ({ id: s.id, name: s.name })));

  for (const s of subsToUpdate) {
    try {
      const { boardId, cols } = await getSubitemBoardAndColumns(s.id);

      const col = findStatusColumn(cols);
      if (!col) {
        console.warn(`> Coluna "${SUBITEM_STATUS_TITLE}" não encontrada no board ${boardId} para subitem ${s.id}. Colunas disponíveis:`, cols.map(c => ({ id: c.id, title: c.title, type: c.type })));
        continue;
      }

      console.log(`> Found status column for subitem ${s.id}: id=${col.id} title="${col.title}" type=${col.type}`);
      const result = await changeSubitemStatusByIndex(s.id, boardId, col.id, FECHADO_STATUS_INDEX);

      if (result && result.errors) {
        console.error(`> Erro retornado na mutation para subitem ${s.id}:`, JSON.stringify(result.errors, null, 2));
      } else {
        console.log(`> Mutation executada para subitem ${s.id} — verifique atualização na UI.`);
      }

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`> Erro ao processar subitem ${s.id}:`, err.message || err);
    }
  }

  console.log('> processEvent concluído.');
}

// Rota webhook (challenge handling)
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  if (body.challenge) {
    console.log('Respondendo challenge do monday:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }
  res.sendStatus(200);
  processEvent(body).catch(err => console.error('processEvent erro:', err));
});

app.get('/webhook', (_req, res) => res.send('Webhook show de bola'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT}`));
