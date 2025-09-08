// archive-old-items.js (versão robusta)
// Dependências: express, body-parser, node-fetch
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
const DAYS = Number(process.env.DAYS || 202);
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

// --- Parser robusto de data (aceita pt-BR month names, dd/mm/yyyy, ISO, value JSON, etc.) ---
function parseDateTolerant(text) {
  if (!text && text !== 0) return null;
  const s = String(text).trim();
  if (!s) return null;

  // map de abreviações pt-br para eng (3 letras)
  const monthMap = {
    'jan': 'Jan', 'fev': 'Feb', 'mar': 'Mar', 'abr': 'Apr', 'mai': 'May', 'jun': 'Jun',
    'jul': 'Jul', 'ago': 'Aug', 'set': 'Sep', 'out': 'Oct', 'nov': 'Nov', 'dez': 'Dec'
  };

  // 1) ISO date yyyy-mm-dd or datetime
  const isoMatch = s.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?/);
  if (isoMatch) {
    try {
      const candidate = isoMatch[0].endsWith('Z') ? isoMatch[0] : isoMatch[0] + 'Z';
      const d = new Date(candidate);
      if (!isNaN(d)) return d;
    } catch (e) {}
  }

  // 2) dd/mm/yyyy
  const dm = s.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (dm) {
    try {
      const parts = dm[1].split('/');
      const candidate = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}T00:00:00Z`;
      const d = new Date(candidate);
      if (!isNaN(d)) return d;
    } catch (e) {}
  }

  // 3) MonthName dd, yyyy  (ex: mai 26, 2025 OR May 26, 2025)
  const m = s.match(/([A-Za-zÀ-ú]{3,})\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    try {
      const mon3 = m[1].slice(0,3).toLowerCase();
      const eng = monthMap[mon3] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
      const candidate = `${eng} ${m[2]}, ${m[3]}`;
      const d = new Date(candidate);
      if (!isNaN(d)) return d;
    } catch (e) {}
  }

  // 4) tentar extrair yyyy-mm-dd isolado
  const ymd = s.match(/\d{4}-\d{2}-\d{2}/);
  if (ymd) {
    try {
      const d = new Date(ymd[0] + 'T00:00:00Z');
      if (!isNaN(d)) return d;
    } catch (e) {}
  }

  // 5) tentativa direta (last resort)
  const d2 = new Date(s);
  if (!isNaN(d2)) return d2;

  return null;
}

// --- Extrai a "last updated" a partir do item inteiro (item.updated_at + column_values) ---
function parseLastUpdatedFromItem(item) {
  // 1) item.updated_at preferencial
  if (item && item.updated_at) {
    const d = new Date(item.updated_at);
    if (!isNaN(d)) return d;
  }

  // 2) procurar coluna explicitamente 'last_updated' primeiro
  const cvs = Array.isArray(item.column_values) ? item.column_values : [];
  const explicit = cvs.find(c => c && (c.id === 'last_updated' || (c.type && typeof c.type === 'string' && c.type.includes('last_updated'))));
  if (explicit) {
    // some LastUpdatedValue may include updated_at
    if (explicit.updated_at) {
      const d = new Date(explicit.updated_at);
      if (!isNaN(d)) return d;
    }
    if (explicit.text) {
      const p = parseDateTolerant(explicit.text);
      if (p) return p;
    }
  }

  // 3) varrer todas as column_values e tentar extrair
  for (const c of cvs) {
    if (!c) continue;

    if (c.updated_at) {
      const d = new Date(c.updated_at);
      if (!isNaN(d)) return d;
    }

    if (c.text) {
      const p = parseDateTolerant(c.text);
      if (p) return p;
    }

    if (c.value) {
      // value pode ser JSON com date/datetime
      try {
        const val = JSON.parse(c.value);
        if (val) {
          const candidate = val.date || val.datetime || val.updated_at || val.timestamp || val.value;
          if (candidate) {
            const p = parseDateTolerant(candidate);
            if (p) return p;
          }
        }
      } catch (e) {
        // não JSON: ignorar
      }
    }
  }

  // nada encontrado
  return null;
}

// --- Consulta uma "página" de um board específico ---
async function processBoardPage(boardId, cursor) {
  const qFirst = `
    query ($boardId: Int!, $limit: Int!) {
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

  const vars = cursor ? { cursor, limit: 200 } : { boardId: Number(boardId), limit: 200 };
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

// --- Rotina principal: varre cada board separadamente ---
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
      try {
        res = await processBoardPage(boardId, cursor);
      } catch (err) {
        console.error(`Erro ao buscar página (board ${boardId}):`, err);
        break;
      }
      if (!res) {
        console.log(`> Board ${boardId}: sem mais páginas / sem itens retornados.`);
        break;
      }

      const items = res.items || [];
      console.log(`> Board ${boardId} — itens nesta página: ${items.length}`);

      for (const it of items) {
        const last = parseLastUpdatedFromItem(it);
        if (!last) {
          console.log(`[SEM DATA] ${it.id} "${it.name}" — column_values: ${JSON.stringify(it.column_values || []).slice(0,200)}`);
          continue;
        }

        if (last < cutoff) {
          console.log(`[CANDIDATO] ${it.id} "${it.name}" — last=${last.toISOString()}`);
          if (!DRY_RUN) {
            try {
              await archiveItem(Number(it.id));
              console.log(`[ARQUIVADO] ${it.id}`);
              totalArchived++;
              // pequeno delay entre arquivamentos pra evitar throttling
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
      // pequeno delay entre páginas para evitar throttling
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`>>> runArchive FINALIZADO. Total arquivado: ${totalArchived}`);
  return totalArchived;
}

// --- Rotas HTTP ---
app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));

app.post('/archive', (_req, res) => {
  // responde imediatamente e roda o processo em background
  res.json({ ok: true, boot: BOOT_ID, dryRun: DRY_RUN, started: new Date().toISOString() });

  runArchive()
    .then(() => console.log('>>> runArchive concluído sem erros'))
    .catch(err => console.error('Erro em runArchive:', err));
});

// --- Start server ---
const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));

