const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// Variáveis de ambiente
const API_KEY = process.env.MONDAY_API_KEY;
if (!API_KEY) {
  console.error('ERRO: MONDAY_API_KEY não definido.');
  process.exit(1);
}
const BOARD_ID = Number(process.env.BOARD_ID || 7991681616);
const DAYS = Number(process.env.DAYS || 90);
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`PID: ${process.pid}`);
console.log('--------------------------------------------');

// Função auxiliar para chamar GraphQL
async function gql(query, variables = {}) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) {
    console.warn('>> GraphQL ERROS:', JSON.stringify(data.errors, null, 2));
    throw new Error('GraphQL error: ' + JSON.stringify(data.errors));
  }
  return data.data;
}

function parseLastUpdated(colValues) {
  if (!Array.isArray(colValues)) return null;
  const v = colValues.find(c => c.id === 'last_updated' || (c.type || '').includes('last_updated')) || colValues[0];
  if (v?.updated_at) return new Date(v.updated_at);
  if (v?.text) {
    const d = new Date(v.text);
    if (!isNaN(d)) return d;
  }
  return null;
}

// Processa uma página
async function processPage(cursor) {
  const qFirst = `
    query ($boardId: Int!, $limit: Int!) {
      boards(ids: $boardId) {
        items_page(limit: $limit) {
          cursor
          items {
            id
            name
            column_values(types:[last_updated]) {
              id
              text
              ... on LastUpdatedValue { updated_at updater_id }
            }
          }
        }
      }
    }`;
  const qNext = `
    query ($cursor: String!, $limit: Int!) {
      next_items_page(cursor: $cursor, limit: $limit) {
        cursor
        items {
          id
          name
          column_values(types:[last_updated]) {
            id
            text
            ... on LastUpdatedValue { updated_at updater_id }
          }
        }
      }
    }`;
  const vars = cursor ? { cursor, limit: 200 } : { boardId: BOARD_ID, limit: 200 };

  const data = await gql(cursor ? qNext : qFirst, vars);
  return cursor ? data.next_items_page : data.boards[0].items_page;
}

async function archiveItem(itemId) {
  const mutation = `mutation ($itemId: Int!) {
    archive_item(item_id: $itemId) { id }
  }`;
  return gql(mutation, { itemId });
}

async function runArchive() {
  console.log('=== Iniciando varredura para arquivar itens velhos ===');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  let cursor = null;
  let totalArchived = 0;
  let page = 1;

  while (true) {
    console.log(`> Processando página ${page}...`);
    const res = await processPage(cursor);
    if (!res) break;

    for (const it of res.items || []) {
      const last = parseLastUpdated(it.column_values);
      if (last && last < cutoff) {
        console.log(`[CANDIDATO] ${it.id} "${it.name}" — last=${last.toISOString()}`);
        if (!DRY_RUN) {
          await archiveItem(Number(it.id));
          console.log(`[ARQUIVADO] ${it.id}`);
          totalArchived++;
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }

    cursor = res.cursor;
    if (!cursor) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`=== Fim da varredura. Total arquivado: ${totalArchived} ===`);
  return totalArchived;
}

// Rotas
app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));

app.post('/archive', async (_req, res) => {
  res.json({ ok: true, boot: BOOT_ID, dryRun: DRY_RUN, started: new Date().toISOString() });
  try {
    await runArchive();
  } catch (err) {
    console.error('Erro em runArchive:', err);
  }
});

// Start server
const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
