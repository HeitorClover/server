// archive-old-items.js
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// --- Config via env ---
const API_KEY = process.env.MONDAY_API_KEY;
if (!API_KEY) {
  console.error('ERRO: MONDAY_API_KEY não definido. Defina a variável de ambiente MONDAY_API_KEY.');
  process.exit(1);
}

// BOARD_ID pode ser um único id (string/number) ou uma lista separada por vírgulas.
// Ex.: BOARD_ID=7991681616  OU  BOARD_ID=7991681616,123456789
const rawBoardId = process.env.BOARD_ID || '7991681616';
const BOARD_IDS = rawBoardId
  .toString()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// DAYS e DRY_RUN
const DAYS = Number(process.env.DAYS || 252);
const DRY_RUN = (process.env.DRY_RUN || 'true').toString().toLowerCase() === 'true';

const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`PID: ${process.pid}`);
console.log(`MONDAY_BOARDS: ${JSON.stringify(BOARD_IDS)}`);
console.log(`DAYS: ${DAYS}`);
console.log(`DRY_RUN: ${DRY_RUN}`);
console.log('--------------------------------------------');

// --- Helper: GraphQL request to Monday ---
async function gql(query, variables = {}) {
  const resp = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();
  if (json.errors) {
    console.warn('>> GraphQL ERROS:', JSON.stringify(json.errors, null, 2));
    throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

// --- Helper: extrai data de "last updated" a partir de column_values ---
function parseLastUpdated(colValues) {
  if (!Array.isArray(colValues) || colValues.length === 0) return null;

  // tenta encontrar coluna do tipo last_updated ou com id last_updated
  const candidate = colValues.find(
    c => c.id === 'last_updated' || (c.type && c.type.includes && c.type.includes('last_updated'))
  ) || colValues[0];

  // se tiver propriedade updated_at (caso do LastUpdatedValue)
  if (candidate && candidate.updated_at) {
    const d = new Date(candidate.updated_at);
    if (!isNaN(d)) return d;
  }

  // se tiver text que represente data
  if (candidate && candidate.text) {
    const d = new Date(candidate.text);
    if (!isNaN(d)) return d;
  }

  return null;
}

// --- Pegar uma "página" de itens ---
// Usamos boards(ids: $boardIds) { items_page(limit: $limit) { cursor items { ... } } }
// e next_items_page(cursor: $cursor, limit: $limit) para paginação
async function processPage(cursor) {
  const qFirst = `
    query ($boardIds: [ID!]!, $limit: Int!) {
      boards(ids: $boardIds) {
        items_page(limit: $limit) {
          cursor
          items {
            id
            name
            column_values {
              id
              text
              type
              # tentativa de pegar campo updated_at quando for LastUpdatedValue
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
          column_values {
            id
            text
            type
            ... on LastUpdatedValue { updated_at updater_id }
          }
        }
      }
    }`;

  const vars = cursor ? { cursor, limit: 200 } : { boardIds: BOARD_IDS, limit: 200 };

  const data = await gql(cursor ? qNext : qFirst, vars);

  if (cursor) {
    return data && data.next_items_page ? data.next_items_page : null;
  } else {
    // data.boards pode ser array vazio por algum motivo; garantir safe access
    if (!data || !Array.isArray(data.boards) || data.boards.length === 0) return null;
    return data.boards[0].items_page;
  }
}

// --- Mutação para arquivar item ---
async function archiveItem(itemId) {
  const mutation = `mutation ($itemId: Int!) { archive_item(item_id: $itemId) { id } }`;
  return gql(mutation, { itemId });
}

// --- Rotina principal de varredura e arquivamento ---
async function runArchive() {
  console.log('=== Iniciando varredura para arquivar itens velhos ===');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  let cursor = null;
  let page = 1;
  let totalArchived = 0;

  while (true) {
    console.log(`> Processando página ${page}...`);
    let res;
    try {
      res = await processPage(cursor);
    } catch (err) {
      console.error('Erro ao buscar página:', err);
      break;
    }
    if (!res) {
      console.log('> Sem mais páginas / sem itens retornados.');
      break;
    }

    const items = res.items || [];
    for (const it of items) {
      const last = parseLastUpdated(it.column_values);
      if (last && last < cutoff) {
        console.log(`[CANDIDATO] ${it.id} "${it.name}" — last=${last.toISOString()}`);
        if (!DRY_RUN) {
          try {
            await archiveItem(Number(it.id));
            console.log(`[ARQUIVADO] ${it.id}`);
            totalArchived++;
            // pequeno delay para evitar throttling
            await new Promise(r => setTimeout(r, 200));
          } catch (err) {
            console.error(`[ERRO AO ARQUIVAR] ${it.id}:`, err);
          }
        }
      }
    }

    cursor = res.cursor;
    if (!cursor) break;
    page++;
    // pequeno delay entre páginas
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`=== Fim da varredura. Total arquivado: ${totalArchived} ===`);
  return totalArchived;
}

// --- Rotas HTTP ---
app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));

app.post('/archive', async (_req, res) => {
  // responde imediatamente (fire-and-forget) e roda o processo em background
  res.json({ ok: true, boot: BOOT_ID, dryRun: DRY_RUN, started: new Date().toISOString() });
  try {
    await runArchive();
  } catch (err) {
    console.error('Erro em runArchive:', err);
  }
});

// --- Start server ---
const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
