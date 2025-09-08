// archive-old-items-list-and-archive.js
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// --- Config ---
const API_KEY = process.env.MONDAY_API_KEY;
if (!API_KEY) {
  console.error('ERRO: MONDAY_API_KEY não definido.');
  process.exit(1);
}

const rawBoardId = process.env.BOARD_ID || '7991681616';
const BOARD_IDS = rawBoardId.toString().split(',').map(s => s.trim()).filter(Boolean);

const DAYS = Number(process.env.DAYS || 202); // cutoff em dias
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'false';
const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`MONDAY_BOARDS: ${JSON.stringify(BOARD_IDS)}`);
console.log(`DAYS: ${DAYS}`);
console.log(`DRY_RUN: ${DRY_RUN}`);
console.log('--------------------------------------------');

// --- Helper GraphQL ---
async function gql(query, variables = {}) {
  const resp = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors) throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  return json.data;
}

// --- Parser de datas ---
function parseDateTolerant(text) {
  if (!text && text !== 0) return null;
  const s = String(text).trim();
  if (!s) return null;

  const monthMap = {
    'jan':'Jan','fev':'Feb','mar':'Mar','abr':'Apr','mai':'May','jun':'Jun',
    'jul':'Jul','ago':'Aug','set':'Sep','out':'Oct','nov':'Nov','dez':'Dec'
  };

  const isoMatch = s.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?/);
  if (isoMatch) return new Date(isoMatch[0] + (isoMatch[0].endsWith('Z') ? '' : 'Z'));

  const dm = s.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (dm) {
    const parts = dm[1].split('/');
    return new Date(`${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}T00:00:00Z`);
  }

  const m = s.match(/([A-Za-zÀ-ú]{3,})\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const mon3 = m[1].slice(0,3).toLowerCase();
    const eng = monthMap[mon3] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
    return new Date(`${eng} ${m[2]}, ${m[3]}`);
  }

  const d2 = new Date(s);
  if (!isNaN(d2)) return d2;
  return null;
}

// --- Extrai last updated ---
function parseLastUpdatedFromItem(item) {
  if (item && item.updated_at) {
    const d = new Date(item.updated_at);
    if (!isNaN(d)) return d;
  }

  const cvs = Array.isArray(item.column_values) ? item.column_values : [];
  for (const c of cvs) {
    if (!c) continue;
    if (c.updated_at) { const d = new Date(c.updated_at); if (!isNaN(d)) return d; }
    if (c.text) { const d = parseDateTolerant(c.text); if (d) return d; }
    if (c.value) {
      try {
        const val = JSON.parse(c.value);
        if (val) {
          const candidate = val.date || val.datetime || val.updated_at || val.timestamp || val.value;
          if (candidate) { const d = parseDateTolerant(candidate); if (d) return d; }
        }
      } catch(e){}
    }
  }
  return null;
}

// --- Consulta uma página ---
async function processBoardPage(boardId, cursor) {
  const qFirst = `
    query ($boardId: ID!, $limit: Int!) {
      boards(ids: [$boardId]) {
        items_page(limit: $limit) {
          cursor
          items {
            id
            name
            updated_at
            column_values {
              id
              text
              type
              value
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
          updated_at
          column_values {
            id
            text
            type
            value
            ... on LastUpdatedValue { updated_at updater_id }
          }
        }
      }
    }`;

  const vars = cursor ? { cursor, limit: 200 } : { boardId: String(boardId), limit: 200 };
  const data = await gql(cursor ? qNext : qFirst, vars);

  if (cursor) return data && data.next_items_page ? data.next_items_page : null;
  if (!data || !Array.isArray(data.boards) || data.boards.length === 0) return null;
  return data.boards[0].items_page;
}

// --- Arquiva item ---
async function archiveItem(itemId) {
  const mutation = `mutation ($itemId: Int!) { archive_item(item_id: $itemId) { id } }`;
  return gql(mutation, { itemId });
}

// --- Rotina principal ---
async function runArchive() {
  console.log('>>> runArchive INICIADO às', new Date().toISOString());
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  let totalArchived = 0;

  for (const boardId of BOARD_IDS) {
    console.log(`-- Processando board ${boardId} --`);
    let cursor = null;
    let page = 1;

    while (true) {
      console.log(`> Board ${boardId} — processando página ${page}...`);
      let res;
      try { res = await processBoardPage(boardId, cursor); } 
      catch (err) { console.error(`Erro ao buscar página (board ${boardId}):`, err); break; }
      if (!res) { console.log(`> Board ${boardId}: sem mais páginas.`); break; }

      const items = res.items || [];
      for (const it of items) {
        const last = parseLastUpdatedFromItem(it);
        if (!last) continue;
        if (last < cutoff) {
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
  }

  console.log(`>>> runArchive FINALIZADO. Total arquivado: ${totalArchived}`);
  return totalArchived;
}

// --- Rotas HTTP ---
app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));

app.post('/archive', (_req, res) => {
  res.json({ ok: true, boot: BOOT_ID, dryRun: DRY_RUN, started: new Date().toISOString() });
  runArchive().then(() => console.log('>>> runArchive concluído sem erros'))
              .catch(err => console.error('Erro em runArchive:', err));
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
