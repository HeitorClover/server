// serve.js
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
  // Já existentes
  'abrir conta',
  'comercial',
  'documentos',
  'caixaaqui',
  'doc pendente',
  'assinatura',
  'restrição',
  'conformidade',
  'avaliação',
  'conta ativa',
  'desist/demora',
  'aprovado',
  'condicionado',
  'reprovado',
  'analise',
  'engenharia',
  'projetos',

  // Novos da imagem 1
  'pago',
  'não pago',

  // Novos da imagem 2
  'projetos',
  'escritura',
  'ab matricula',
  'alvará',
  'pci',
  'o.s concluida',
  'proj aprovado',
  'engenharia',
  'unificação',
  'desmembramento'
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
  console.log('> resposta board+columns (raw):', JSON.stringify(data, null, 2));
  const item = data.items?.[0];
  if (!item || !item.board) throw new Error(`Não achei board para subitem ${subitemId}`);
  return { boardId: item.board.id, cols: item.board.columns || [] };
}

// Encontra coluna
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

  if (expectedType) {
    const byType = cols.find(c => (c.type || '').toLowerCase().includes(String(expectedType || '').toLowerCase()));
    if (byType) {
      console.log(`> Encontrada coluna por tipo fallback: id=${byType.id} title="${byType.title}" type=${byType.type}`);
      return byType;
    }
  }

  const bySub = cols.find(c => (c.title || '').toLowerCase().includes((title || '').toLowerCase()));
  if (bySub) {
    console.log(`> Encontrada coluna por substring no título: id=${bySub.id} title="${bySub.title}" type=${bySub.type}`);
    return bySub;
  }
  console.log(`> NÃO encontrou coluna title="${title}" type="${expectedType}"`);
  return null;
}

// Seta data + hora atual na coluna de FINALIZAÇÃO
async function setTodayDate(subitemId, boardId, columnId) {
  const now = new Date();

  // Formata data YYYY-MM-DD
  const date = now.toISOString().split('T')[0];

  // Formata hora HH:MM:SS (pad com zeros quando necessário)
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  console.log(`> setTodayDate -> subitem ${subitemId}, date ${date}, time ${time}, board ${boardId}, column ${columnId}`);

  // o monday espera um JSON stringificado com { "date": "...", "time": "..." }
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

// Webhook
async function processEvent(body) {
  console.log('--- processEvent body:', JSON.stringify(body, null, 2));
  const ev = body.event || {};

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

  // checa se o status está na lista de aceitos
  if (!ACCEPT.map(s => s.toLowerCase()).includes(statusText.toLowerCase())) {
    console.log(`> Status "${statusText}" não é aceito — ignorando.`);
    return;
  }

  // identificar itemId de várias possíveis chaves no payload
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

      // localizar coluna de data FINALIZAÇÃO
      const dateCol = findColumn(cols, DATE_COL_TITLE, 'date');

      if (!dateCol) {
        console.warn(`> Coluna de data "${DATE_COL_TITLE}" não encontrada para subitem ${s.id}`);
      } else {
        await setTodayDate(s.id, boardId, dateCol.id);
      }

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
    console.log('> Respondendo challenge do monday');
    return res.status(200).json({ challenge: body.challenge });
  }
  // responder rápido e processar em background
  res.status(200).json({ ok: true, boot: BOOT_ID });
  processEvent(body).catch(err => console.error('processEvent erro:', err));
});

app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));
app.get('/webhook', (_req, res) => res.json({ status: 'ok', now: new Date().toISOString(), boot_id: BOOT_ID }));

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));
