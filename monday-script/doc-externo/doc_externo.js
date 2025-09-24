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

// Obtém todos os subitens de um item pai
async function getSubitemsOfItem(itemId) {
  const query = `query { 
    items(ids: ${itemId}) { 
      id 
      subitems { 
        id 
        name 
      } 
    } 
  }`;
  
  try {
    const data = await gql(query);
    return data.items?.[0]?.subitems || [];
  } catch (error) {
    console.error(`Erro ao obter subitems do item ${itemId}:`, error);
    return [];
  }
}

// Encontra subitem pelo nome
async function findSubitemByName(itemId, subitemName) {
  const subitems = await getSubitemsOfItem(itemId);
  return subitems.find(subitem => 
    subitem.name.toLowerCase().includes(subitemName.toLowerCase())
  );
}

// Obtém o responsável de um subitem
async function getResponsibleFromSubitem(subitemId) {
  try {
    const query = `query {
      items(ids: ${subitemId}) {
        id
        name
        column_values {
          column {
            title
            id
          }
          text
          value
        }
      }
    }`;
    
    const data = await gql(query);
    if (!data.items || data.items.length === 0) {
      console.warn(`> Subitem ${subitemId} não encontrado`);
      return null;
    }

    const columnValues = data.items[0].column_values;
    
    // Encontrar a coluna de responsável
    const responsibleCol = columnValues.find(col => 
      col.column && col.column.title && col.column.title.toLowerCase().includes('responsável')
    );
    
    if (!responsibleCol || !responsibleCol.value || responsibleCol.value === '""') {
      console.log(`> Nenhum responsável definido no subitem ${subitemId}`);
      return null;
    }
    
    // Parse do valor da coluna de pessoas
    try {
      const valueJson = JSON.parse(responsibleCol.value);
      if (valueJson.personsAndTeams && valueJson.personsAndTeams.length > 0) {
        const responsibleId = valueJson.personsAndTeams[0].id;
        console.log(`> Responsável encontrado: ${responsibleId}`);
        return responsibleId;
      }
    } catch (parseError) {
      console.warn(`> Valor da coluna responsável não é um JSON válido: ${responsibleCol.value}`);
    }
    
    return null;
  } catch (err) {
    console.error(`> Erro ao obter responsável do subitem ${subitemId}:`, err);
    return null;
  }
}

// Atribui usuário a um subitem
async function assignUserToSubitem(subitemId, boardId, cols, userId) {
  try {
    const responsibleCol = cols.find(col => 
      col.title && col.title.toLowerCase().includes('responsável')
    );
    
    if (!responsibleCol) {
      console.warn(`> Coluna "RESPONSÁVEL" não encontrada no subitem ${subitemId}`);
      return;
    }

    const value = { personsAndTeams: [{ id: Number(userId), kind: "person" }] };
    const valueStr = JSON.stringify(value).replace(/"/g, '\\"');

    const mutation = `mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${subitemId},
        column_id: "${responsibleCol.id}",
        value: "${valueStr}"
      ) { id }
    }`;

    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    const json = await res.json();
    console.log(`> assignUserToSubitem result for ${subitemId}:`, JSON.stringify(json, null, 2));
  } catch (err) {
    console.error(`> Erro ao atribuir usuário no subitem ${subitemId}:`, err);
  }
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

// Obtém o board e colunas do subitem
async function getSubitemBoardAndColumns(subitemId) {
  const query = `query {
    items(ids: ${subitemId}) {
      id
      board {
        id
        columns { id title type settings_str }
      }
    }
  }`;
  
  try {
    const data = await gql(query);
    const item = data.items[0];
    if (!item || !item.board) throw new Error(`Não achei board para subitem ${subitemId}`);
    return { boardId: item.board.id, cols: item.board.columns || [] };
  } catch (error) {
    console.error(`Erro ao obter board do subitem ${subitemId}:`, error);
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

// Função para setar data e hora atual
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

// Encontra coluna DOC EXTERNO no item pai
function findDocExternoColumn(cols) {
  if (!Array.isArray(cols)) return null;
  
  // Busca pelo título exato "DOC EXTERNO"
  const exactMatch = cols.find(c => 
    c.title && c.title.toUpperCase() === 'DOC EXTERNO'
  );
  if (exactMatch) return exactMatch;
  
  // Se não encontrar, busca por variações
  const variations = cols.find(c => 
    c.title && c.title.toUpperCase().includes('DOC EXTERNO')
  );
  
  return variations || null;
}

// Encontra coluna O.S. no item pai
function findOSColumn(cols) {
  if (!Array.isArray(cols)) return null;
  
  // Busca por variações do nome "O. S."
  const variations = [
    'O. S.',
    'O.S.',
    'OS',
    'ordem de serviço',
    'ordem de servico'
  ];
  
  for (const variation of variations) {
    const column = cols.find(c => 
      c.title && c.title.toUpperCase().includes(variation.toUpperCase())
    );
    if (column) return column;
  }
  
  return null;
}

// Atualiza uma coluna de status do item pai com uma etiqueta específica
async function updateStatusColumn(parentItem, columnName, labelText) {
  try {
    if (!parentItem || !parentItem.board) {
      console.warn('Item pai ou board não encontrado');
      return false;
    }

    // Busca a coluna específica
    let targetColumn = null;
    
    if (columnName === 'DOC EXTERNO') {
      targetColumn = findDocExternoColumn(parentItem.board.columns);
    } else if (columnName === 'O. S.') {
      targetColumn = findOSColumn(parentItem.board.columns);
    }
    
    if (!targetColumn) {
      console.warn(`Coluna "${columnName}" não encontrada no item pai ${parentItem.id}`);
      return false;
    }

    console.log(`> Coluna "${columnName}" encontrada: ${targetColumn.title} (${targetColumn.id})`);

    const valueJson = JSON.stringify({ label: labelText });
    const escapedValue = valueJson.replace(/"/g, '\\"');

    const mutation = `mutation {
      change_column_value(
        board_id: ${parentItem.board.id},
        item_id: ${parentItem.id},
        column_id: "${targetColumn.id}",
        value: "${escapedValue}"
      ) { id }
    }`;

    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    
    const json = await res.json();
    
    if (json.errors) {
      console.error('Erros na mutation:', JSON.stringify(json.errors, null, 2));
      return false;
    }
    
    console.log(`✅ "${labelText}" aplicado na coluna ${columnName} do item pai ${parentItem.id}`);
    return true;
  } catch (error) {
    console.error(`Erro ao atualizar coluna ${columnName} no item pai ${parentItem.id}:`, error);
    return false;
  }
}

// Obtém informações completas do item
async function getItemDetails(itemId) {
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
    return data.items ? data.items[0] : null;
  } catch (error) {
    console.error(`Erro ao obter detalhes do item ${itemId}:`, error);
    return null;
  }
}

// Obtém o título da coluna pelo ID
async function getColumnTitle(columnId) {
  try {
    const query = `query {
      boards(limit: 1) {
        columns(ids: ["${columnId}"]) {
          title
          type
        }
      }
    }`;
    
    const data = await gql(query);
    if (data.boards && data.boards.length > 0 && data.boards[0].columns.length > 0) {
      return data.boards[0].columns[0].title;
    }
    return null;
  } catch (error) {
    console.error(`Erro ao obter título da coluna ${columnId}:`, error);
    return null;
  }
}

// Função para copiar responsável após 30 segundos
async function copyResponsavelToPCI(itemId) {
  console.log(`> Aguardando 30 segundos antes de copiar responsável...`);
  
  await new Promise(res => setTimeout(res, 30 * 1000));
  
  console.log(`> Procurando subitems após 30 segundos...`);
  
  const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
  if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
    console.warn(`> Nenhum subitem encontrado após 30 segundos`);
    return;
  }
  
  // Procura o subitem PCI / MEMORIAL
  const pciMemorialSubitem = await findSubitemByName(Number(itemId), 'PCI / MEMORIAL');
  if (!pciMemorialSubitem) {
    console.warn(`> Subitem "PCI / MEMORIAL" não encontrado para o item ${itemId}`);
    return;
  }
  
  console.log(`> Subitem "PCI / MEMORIAL" encontrado (ID: ${pciMemorialSubitem.id})`);
  
  // Procura o subitem ESCOLHA DE PROJETO
  const escolhaProjetoSubitem = await findSubitemByName(Number(itemId), 'ESCOLHA DE PROJETO');
  if (!escolhaProjetoSubitem) {
    console.warn(`> Subitem "ESCOLHA DE PROJETO" não encontrado para o item ${itemId}`);
    return;
  }
  
  console.log(`> Subitem "ESCOLHA DE PROJETO" encontrado (ID: ${escolhaProjetoSubitem.id})`);
  
  // Obtém o responsável do ESCOLHA DE PROJETO
  const responsibleUserId = await getResponsibleFromSubitem(escolhaProjetoSubitem.id);
  if (!responsibleUserId) {
    console.warn(`> Nenhum responsável encontrado no subitem "ESCOLHA DE PROJETO"`);
    return;
  }
  
  console.log(`> Responsável encontrado: ${responsibleUserId}`);
  
  // Obtém o board e colunas do subitem PCI / MEMORIAL
  const { boardId, cols } = await getSubitemBoardAndColumns(pciMemorialSubitem.id);
  
  // Atribui o responsável ao PCI / MEMORIAL
  await assignUserToSubitem(pciMemorialSubitem.id, boardId, cols, responsibleUserId);
  console.log(`✅ Responsável copiado de "ESCOLHA DE PROJETO" para "PCI / MEMORIAL"`);
}

// Processa evento de webhook
async function processWebhookEvent(body) {
  try {
    const event = body.event || {};
    
    console.log('📥 Evento recebido:', JSON.stringify(event, null, 2));

    // Aceitar ambos os tipos de evento
    if (event.type !== 'change_column_value' && event.type !== 'update_column_value') {
      console.log('⏭️ Não é evento de mudança de coluna, ignorando.');
      return;
    }

    // Obtém o ID do item (subitem)
    const itemId = event.pulseId || event.pulse_id;
    if (!itemId) {
      console.warn('⚠️ ID do item não encontrado no evento');
      return;
    }

    // Verificar se é uma coluna do tipo boolean (checkbox)
    const columnTitle = await getColumnTitle(event.columnId);
    console.log(`> Título da coluna: ${columnTitle}`);
    
    // Verifica se é a coluna correta (sinal de confirmação ou qualquer coluna boolean)
    if (columnTitle && columnTitle.toLowerCase() !== 'sinal de confirmação') {
      console.log(`⏭️ Coluna "${columnTitle}" não é "sinal de confirmação", ignorando.`);
      return;
    }

    // Obtém informações do item
    const item = await getItemDetails(itemId);
    if (!item) {
      console.warn(`⚠️ Item ${itemId} não encontrado`);
      return;
    }

    console.log(`🔍 Processando subitem: "${item.name}"`);

    // Verifica se o checkbox está marcado
    let isChecked = false;
    try {
      // O valor do checkbox vem diretamente no evento
      if (event.value && event.value.checked !== undefined) {
        isChecked = event.value.checked === true;
      } else {
        // Se não veio no evento, busca da coluna
        const checkboxColumn = item.column_values.find(cv => 
          cv.column && (cv.column.type === 'boolean' || cv.column.type === 'checkbox')
        );
        if (checkboxColumn) {
          const checkboxValue = JSON.parse(checkboxColumn.value || '{}');
          isChecked = checkboxValue.checked === true;
        }
      }
    } catch (e) {
      console.warn('⚠️ Não foi possível determinar estado do checkbox');
      return;
    }

    if (!isChecked) {
      console.log('⏭️ Checkbox não está marcado, ignorando.');
      return;
    }

    console.log(`✅ Checkbox marcado detectado para: ${item.name}`);

    // 1. AÇÃO: Atualizar coluna FINALIZAÇÃO no próprio subitem (PARA QUALQUER SUBITEM)
    const subitemBoardInfo = await getSubitemBoardAndColumns(itemId);
    if (subitemBoardInfo) {
      const finalizacaoColumn = findColumn(subitemBoardInfo.cols, 'FINALIZAÇÃO', 'date');
      if (finalizacaoColumn) {
        await setTodayDate(itemId, subitemBoardInfo.boardId, finalizacaoColumn.id);
        console.log(`✅ Data/hora atual definida na coluna FINALIZAÇÃO do subitem ${itemId}`);
      } else {
        console.warn(`⚠️ Coluna "FINALIZAÇÃO" não encontrada no subitem ${itemId}`);
      }
    }

    // 2. AÇÃO: Copiar responsável após 30 segundos (PARA QUALQUER SUBITEM)
    const parentItem = await getParentItem(itemId);
    if (parentItem) {
      console.log(`> Agendando cópia de responsável para daqui a 30 segundos...`);
      copyResponsavelToPCI(parentItem.id).catch(err => 
        console.error('Erro ao copiar responsável:', err)
      );
    }

    // 3. AÇÃO: Atualizar colunas no item pai baseado no tipo de subitem (MANTIDO PARA OS CASOS ESPECÍFICOS)
    const itemName = item.name.toUpperCase();
    const isUnificacaoIniciada = itemName.includes('UNIFICAÇÃO INICIADA');
    const isDesmembramentoIniciado = itemName.includes('DESMEMBRAMENTO INICIADO');
    const isProjIniciado = itemName.includes('PROJETO INICIADO');
    const isDocEmitirAlvara = itemName.includes('DOC - EMITIR ALVARÁ');

    if (parentItem && (isUnificacaoIniciada || isDesmembramentoIniciado || isProjIniciado || isDocEmitirAlvara)) {
      console.log(`👤 Item pai encontrado: "${parentItem.name}" (ID: ${parentItem.id})`);

      if (isUnificacaoIniciada) {
        await updateStatusColumn(parentItem, 'DOC EXTERNO', 'DOC - UNIFICAÇÃO');
        console.log(`✅ DOC - UNIFICAÇÃO aplicado na coluna DOC EXTERNO do item pai ${parentItem.id}`);
      } 
      else if (isDesmembramentoIniciado) {
        await updateStatusColumn(parentItem, 'DOC EXTERNO', 'DOC - DESMEMBRAMENTO');
        console.log(`✅ DOC - DESMEMBRAMENTO aplicado na coluna DOC EXTERNO do item pai ${parentItem.id}`);
      }
      else if (isProjIniciado) {
        // Para PROJ INICIADO: atualiza duas colunas
        await updateStatusColumn(parentItem, 'O. S.', 'PCI/MEMORIAL');
        await updateStatusColumn(parentItem, 'DOC EXTERNO', 'EMITIR ALVARÁ');
        console.log(`✅ PCI/MEMORIAL aplicado na coluna O.S. do item pai ${parentItem.id}`);
        console.log(`✅ EMITIR ALVARÁ aplicado na coluna DOC EXTERNO do item pai ${parentItem.id}`);
      }
      else if (isDocEmitirAlvara) {
        await updateStatusColumn(parentItem, 'DOC EXTERNO', 'ALVARÁ EMITIDO');
        console.log(`✅ ALVARÁ EMITIDO aplicado na coluna DOC EXTERNO do item pai ${parentItem.id}`);
      }
    }

    console.log(`✅ Ações concluídas para subitem ${itemId}`);

  } catch (error) {
    console.error('❌ Erro ao processar evento de webhook:', error);
  }
}

// Rota webhook principal
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  
  // Resposta ao challenge do Monday
  if (body.challenge) {
    console.log('🔐 Challenge recebido:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }
  
  res.status(200).json({ ok: true, boot: BOOT_ID, service: 'doc_externo' });
  
  // Processa o evento assincronamente
  processWebhookEvent(body).catch(err => 
    console.error('💥 Erro no processWebhookEvent:', err)
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