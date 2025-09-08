// archive-old-items.js (atualizado: parseLastUpdated mais robusta)
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
const DAYS = Number(process.env.DAYS || 100);
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
  // Versão mais robusta: tenta várias estratégias para extrair uma data válida
  if (!Array.isArray(colValues) || colValues.length === 0) return null;

  // 1) procura explicitamente por coluna com id 'last_updated' ou tipo que contenha 'last_updated'
  const explicit = colValues.find(
    c => (c && (c.id === 'last_updated' || (c.type && typeof c.type === 'string' && c.type.includes('last_updated'))))
  );

  if (explicit) {
    // updated_at quando disponível
    if (explicit.updated_at) {
      const d = new Date(explicit.updated_at);
      if (!isNaN(d)) return d;
    }
    // texto (pode ser ISO ou outro formato)
    if (explicit.text) {
      const d = new Date(explicit.text);
      if (!isNaN(d)) return d;
    }
  }

  // 2) fallback: varre todas as column_values e tenta extrair tokens de data
  for (const c of colValues) {
    if (!c) continue;

    // se tiver updated_at
    if (c.updated_at) {
      const d = new Date(c.updated_at);
      if (!isNaN(d)) return d;
    }

    if (c.text) {
      const t = String(c.text).trim();
      if (!t) continue;

      // tenta ISO (YYYY-MM-DDTHH:MM:SS...)
      const isoMatch = t.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
      if (isoMatch) {
        // garantir fuso UTC se não houver Z
        const candidate = isoMatch[0].endsWith('Z') ? isoMatch[0] : isoMatch[0] + 'Z';
        const d = new Date(candidate);
        if (!isNaN(d)) return d;
      }

      // tenta dd/mm/YYYY
      const dmMatch = t.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
      if (dmMatch) {
        const parts = dmMatch[1].split('/');
        const candidate = `${parts[2]}-${parts[1]}-${parts[0]}T00:00:00Z`;
        const d = new Date(candidate);
        if (!isNaN(d)) return d;
      }

      // tenta extrair só a parte YYYY-MM-DD
      const ymd = t.match(/\d{4}-\d{2}-\d{2}/);
      if (ymd) {
        const d = new Date(ymd[0] + 'T00:00:00Z');
        if (!isNaN(d)) return d;
      }

      // por fim, tenta parse direto
      const d2 = new Date(t);
      if (!isNaN(d2)) return d2;
    }
  }

  // nada válido encontrado
  return null;
}

// --- Pegar uma "página" de itens ---
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
    if (!data || !Array.isArray(data.boards) || data.boards.length === 0) return null;
    return data.boards[0].items_page;
  }
}

// --- Mutação para arquivar item ---
async function archiveItem(itemId) {
  const mutation = `mutation ($itemId: Int!) { archive_item(item_id: $itemId) { id } }`;
  return gql(mutation, { itemId });
}

// --- Rotina principal ---
async function runArchive() {
  console.log('>>> runArchive INICIADO às', new Date().toISOString());
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
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`>>> runArchive FINALIZADO. Total arquivado: ${totalArchived}`);
  return totalArchived;
}

// --- Rotas HTTP ---
app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));

app.post('/archive', (_req, res) => {
  res.json({ ok: true, boot: BOOT_ID, dryRun: DRY_RUN, started: new Date().toISOString() });

  // roda em background
  runArchive()
    .then(() => console.log(">>> runArchive concluído sem erros"))
    .catch(err => console.error("Erro em runArchive:", err));
});

// --- Start server ---
const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
