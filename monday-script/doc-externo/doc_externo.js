// doc_externo.js - Servidor independente para tratamento de documentos
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

const BOOT_ID = process.env.BOOT_ID || `doc-externo-${Date.now()}`;

console.log('--------------------------------------------');
console.log(`DOC_EXTERNO STARTUP: ${new Date().toISOString()}`);
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

// Obtém o item pai de um subitem
async function getParentItem(subitemId) {
  const query = `query {
    items(ids: ${subitemId}) {
      id
      name
      parent_item {
        id
        name
        board {
          id
          columns { id title type settings_str }
        }
      }
    }
  }`;
  
  try {
    const data = await gql(query);
    return data.items[0].parent_item;
  } catch (error) {
    console.error(`Erro ao obter item pai do subitem ${subitemId}:`, error);
    return null;
  }
}

// Encontra coluna pelo título
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

// Atualiza a coluna de etiqueta do item pai
async function updateParentItemLabel(parentItem, labelText) {
  try {
    // Procura coluna do tipo label (etiqueta) - comum para status/documentos
    const labelColumn = findColumn(parentItem.board.columns, 'documentos', 'label') || 
                       findColumn(parentItem.board.columns, 'status', 'label') ||
                       findColumn(parentItem.board.columns, 'etiqueta', 'label') ||
                       findColumn(parentItem.board.columns, 'doc', 'label');
    
    if (!labelColumn) {
      console.warn(`Coluna de etiqueta não encontrada no item pai ${parentItem.id}`);
      return false;
    }

    const mutation = `mutation {
      change_column_value(
        board_id: ${parentItem.board.id},
        item_id: ${parentItem.id},
        column_id: "${labelColumn.id}",
        value: "{\\"label\\":\\"${labelText}\\"}"
      ) { id }
    }`;

    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    
    const json = await res.json();
    console.log(`> Etiqueta "${labelText}" atualizada no item pai ${parentItem.id}`);
    return true;
  } catch (error) {
    console.error(`Erro ao atualizar etiqueta no item pai ${parentItem.id}:`, error);
    throw error;
  }
}

// Obtém informações completas do item (incluindo valor da coluna de checkbox)
async function getItemWithColumnValues(itemId) {
  const query = `query {
    items(ids: ${itemId}) {
      id
      name
      column_values {
        id
        value
        text
        column {
          id
          title
          type
        }
      }
    }
  }`;
  
  try {
    const data = await gql(query);
    return data.items[0];
  } catch (error) {
    console.error(`Erro ao obter informações do item ${itemId}:`, error);
    return null;
  }
}

// Processa evento de webhook
async function processWebhookEvent(body) {
  try {
    const event = body.event || {};
    
    console.log('> Evento recebido:', JSON.stringify({
      type: event.type,
      pulseId: event.pulseId,
      columnId: event.columnId,
      value: event.value
    }, null, 2));

    // Verifica se é um evento de mudança em coluna do tipo checkbox
    if (event.type !== 'change_column_value') {
      console.log('> Não é evento de mudança de coluna, ignorando.');
      return;
    }

    // Obtém o ID do item (subitem)
    const itemId = event.pulseId || event.pulse_id;
    if (!itemId) {
      console.warn('> ID do item não encontrado no evento');
      return;
    }

    // Obtém informações completas do item
    const item = await getItemWithColumnValues(itemId);
    if (!item) {
      console.warn(`> Item ${itemId} não encontrado`);
      return;
    }

    console.log(`> Processando subitem: "${item.name}"`);

    // Verifica se é UNIFICAÇÃO ou DESMEMBRAMENTO
    const itemName = item.name.toUpperCase();
    const isUnificacao = itemName.includes('UNIFICAÇÃO');
    const isDesmembramento = itemName.includes('DESMEMBRAMENTO');

    if (!isUnificacao && !isDesmembramento) {
      console.log('> Subitem não é UNIFICAÇÃO nem DESMEMBRAMENTO, ignorando.');
      return;
    }

    // Encontra a coluna de checkbox no item
    const checkboxColumn = item.column_values.find(cv => 
      cv.column && cv.column.type === 'checkbox'
    );

    if (!checkboxColumn) {
      console.warn('> Coluna de checkbox não encontrada no subitem');
      return;
    }

    // Verifica se o checkbox está marcado
    let isChecked = false;
    try {
      const checkboxValue = JSON.parse(checkboxColumn.value || '{}');
      isChecked = checkboxValue.checked === true;
    } catch (e) {
      console.warn('> Não foi possível parsear valor do checkbox:', checkboxColumn.value);
      return;
    }

    if (!isChecked) {
      console.log('> Checkbox não está marcado, ignorando.');
      return;
    }

    console.log(`> Checkbox marcado detectado para: ${item.name}`);

    // Obtém o item pai
    const parentItem = await getParentItem(itemId);
    if (!parentItem) {
      console.warn('> Item pai não encontrado');
      return;
    }

    console.log(`> Item pai encontrado: "${parentItem.name}" (ID: ${parentItem.id})`);

    // Atualiza a etiqueta no item pai baseado no tipo
    if (isUnificacao) {
      await updateParentItemLabel(parentItem, 'DOC - UNIFICAÇÃO');
      console.log(`✅ DOC - UNIFICAÇÃO aplicado ao item pai ${parentItem.id}`);
    } else if (isDesmembramento) {
      await updateParentItemLabel(parentItem, 'DOC - DESMEMBRAMENTO');
      console.log(`✅ DOC - DESMEMBRAMENTO aplicado ao item pai ${parentItem.id}`);
    }

  } catch (error) {
    console.error('Erro ao processar evento de webhook:', error);
  }
}

// Rota webhook principal
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  
  // Resposta ao challenge do Monday
  if (body.challenge) {
    console.log('> Challenge recebido:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }
  
  res.status(200).json({ ok: true, boot: BOOT_ID, service: 'doc_externo' });
  
  // Processa o evento assincronamente
  processWebhookEvent(body).catch(err => 
    console.error('Erro no processWebhookEvent:', err)
  );
});

// Rotas de health check
app.get('/', (_req, res) => res.send(`Servidor Doc Externo rodando — BOOT_ID: ${BOOT_ID}`));
app.get('/webhook', (_req, res) => res.json({ 
  status: 'ok', 
  now: new Date().toISOString(), 
  boot_id: BOOT_ID,
  service: 'doc_externo'
}));

const PORT = process.env.PORT || 1001;
app.listen(PORT, () => console.log(`📄 Doc Externo rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));