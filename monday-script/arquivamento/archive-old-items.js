// server.js
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

// IDs dos boards fixos no código
const BOARD_IDS = [
  7991681616, 7973161158, 7973161262, 18032049508, 
  7973161359, 7973161448, 7973161553, 7973161664, 18183607637
];

const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutos

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`BOARDS: ${BOARD_IDS.join(', ')}`);
console.log(`TOTAL BOARDS: ${BOARD_IDS.length}`);
console.log(`UPDATE_INTERVAL: ${UPDATE_INTERVAL}ms (5 minutos)`);
console.log('--------------------------------------------');

// Função para extrair data e hora do formato do Monday
function extractMondayDate(dateValue) {
  if (!dateValue) return null;
  
  try {
    if (typeof dateValue === 'string') {
      const dateObj = JSON.parse(dateValue);
      if (dateObj && dateObj.date && dateObj.time) {
        return `${dateObj.date}T${dateObj.time}`;
      }
    } else if (typeof dateValue === 'object' && dateValue.date && dateValue.time) {
      return `${dateValue.date}T${dateValue.time}`;
    }
  } catch (error) {
    console.log('❌ Erro ao extrair data:', error);
  }
  return null;
}

// Função para verificar se uma data do Monday está vazia
function isMondayDateEmpty(dateValue) {
  if (!dateValue) return true;
  try {
    if (typeof dateValue === 'string') {
      const dateObj = JSON.parse(dateValue);
      return !dateObj || !dateObj.date;
    }
    return !dateValue.date;
  } catch (error) {
    return true;
  }
}

// Função para calcular diferença entre datas e formatar
function calculateAndFormatDateDifference(startDateValue, endDateValue = null) {
  const startDate = extractMondayDate(startDateValue);
  if (!startDate) return 'Data inicial inválida';
  
  const endDate = endDateValue ? extractMondayDate(endDateValue) : new Date().toISOString();
  if (!endDate) return 'Data final inválida';
  
  try {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return 'Datas inválidas';
    }
    
    const diffMs = end - start;
    if (diffMs < 0) return 'Data final anterior à inicial';
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    let result = '';
    if (days > 0) result += `${days} dias, `;
    if (hours > 0) result += `${hours} horas, `;
    if (minutes > 0) result += `${minutes} minutos, `;
    result += `${seconds} segundos`;
    
    return result;
    
  } catch (error) {
    return 'Erro no cálculo';
  }
}

// Função para extrair o valor do objeto do Monday
function extractValue(value) {
  if (typeof value === 'object' && value !== null) {
    if (value.value !== undefined) return value.value;
    if (value.text !== undefined) return value.text;
    if (value.date !== undefined) return value;
    return String(value);
  }
  return value;
}

// Função para fazer queries GraphQL
async function gql(query) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      Authorization: API_KEY 
    },
    body: JSON.stringify({ query })
  });
  
  const data = await r.json();
  
  if (data.errors) {
    console.error('❌ Erro na query GraphQL:', JSON.stringify(data.errors, null, 2));
    throw new Error('GraphQL error: ' + JSON.stringify(data.errors));
  }
  
  return data.data;
}

// Função para atualizar a coluna DURAÇÃO
async function updateDurationColumn(itemId, boardId, columnId, durationText) {
  try {
    const mutation = `mutation {
      change_simple_column_value(
        board_id: ${boardId},
        item_id: ${itemId},
        column_id: "${columnId}",
        value: "${durationText.replace(/"/g, '\\"')}"
      ) { id }
    }`;
    
    await gql(mutation);
    return true;
  } catch (error) {
    console.error('❌ Erro ao atualizar DURAÇÃO:', error);
    return false;
  }
}

// Função para buscar todos os subitens de UM board - CORRIGIDA
async function getSubitemsFromBoard(boardId) {
  const query = `query {
    boards(ids: ${boardId}) {
      items_page (query: {limit: 500}) {
        items {
          id
          name
          board {
            id
          }
          column_values {
            column {
              id
              title
            }
            text
            value
          }
          parent_item {
            id
            name
          }
        }
      }
    }
  }`;
  
  try {
    const data = await gql(query);
    
    if (!data.boards || data.boards.length === 0) {
      console.error(`❌ Board ${boardId} não encontrado`);
      return [];
    }
    
    const board = data.boards[0];
    if (!board.items_page || !board.items_page.items) {
      console.log(`📋 Board ${boardId}: 0 itens encontrados`);
      return [];
    }
    
    const items = board.items_page.items;
    const subitems = items.filter(item => item.parent_item !== null);
    
    console.log(`📋 Board ${boardId}: ${subitems.length} subitens de ${items.length} itens totais`);
    return subitems;
    
  } catch (error) {
    console.error(`❌ Erro ao buscar do board ${boardId}:`, error.message);
    return [];
  }
}

// Função para buscar subitens de TODOS os boards
async function getAllSubitemsFromAllBoards() {
  console.log(`🔍 Buscando subitens de ${BOARD_IDS.length} boards...`);
  
  let allSubitems = [];
  let totalProcessed = 0;
  
  for (const boardId of BOARD_IDS) {
    try {
      const subitems = await getSubitemsFromBoard(boardId);
      allSubitems = allSubitems.concat(subitems.map(subitem => ({
        ...subitem,
        sourceBoard: boardId
      })));
      totalProcessed++;
      
      console.log(`✅ Board ${boardId}: ${subitems.length} subitens`);
      
      // Pequena pausa entre boards
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error(`❌ Erro no board ${boardId}:`, error.message);
    }
  }
  
  console.log(`📊 ${totalProcessed}/${BOARD_IDS.length} boards processados`);
  console.log(`📊 Total: ${allSubitems.length} subitens em todos os boards`);
  return allSubitems;
}

// Função para encontrar coluna pelo título
function findColumnByTitle(columns, title) {
  return columns.find(col => 
    col.column.title.toLowerCase() === title.toLowerCase()
  );
}

// Função para processar um subitem individual
async function processSubitem(subitem) {
  try {
    const inicioColumn = findColumnByTitle(subitem.column_values, 'INICIO');
    const finalizacaoColumn = findColumnByTitle(subitem.column_values, 'FINALIZAÇÃO');
    const duracaoColumn = findColumnByTitle(subitem.column_values, 'DURAÇÃO');
    
    // Verificar se temos as colunas necessárias
    if (!inicioColumn) {
      console.log(`⚠️ Subitem ${subitem.id}: Coluna INICIO não encontrada`);
      return false;
    }
    
    if (!duracaoColumn) {
      console.log(`⚠️ Subitem ${subitem.id}: Coluna DURAÇÃO não encontrada`);
      return false;
    }
    
    const inicioValue = extractValue(inicioColumn.value);
    const finalizacaoValue = finalizacaoColumn ? extractValue(finalizacaoColumn.value) : null;
    
    const isFinalizacaoEmpty = !finalizacaoColumn || isMondayDateEmpty(finalizacaoValue);
    
    let durationText;
    if (isFinalizacaoEmpty) {
      durationText = calculateAndFormatDateDifference(inicioValue);
    } else {
      durationText = calculateAndFormatDateDifference(inicioValue, finalizacaoValue);
    }
    
    const success = await updateDurationColumn(
      subitem.id, 
      subitem.board.id, 
      duracaoColumn.column.id, 
      durationText
    );
    
    if (success) {
      console.log(`✅ Subitem ${subitem.id}: "${durationText}"`);
    }
    
    return success;
  } catch (error) {
    console.error(`❌ Erro no subitem ${subitem.id}:`, error.message);
    return false;
  }
}

// Função principal que atualiza todas as durações
async function updateAllDurations() {
  console.log(`\n🔄 [${new Date().toISOString()}] Iniciando atualização em ${BOARD_IDS.length} boards...`);
  
  try {
    const subitems = await getAllSubitemsFromAllBoards();
    let updatedCount = 0;
    let errorCount = 0;
    
    console.log(`🔄 Processando ${subitems.length} subitens...`);
    
    for (const subitem of subitems) {
      const success = await processSubitem(subitem);
      if (success) {
        updatedCount++;
      } else {
        errorCount++;
      }
      
      // Pequena pausa para não sobrecarregar a API
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`✅ [${new Date().toISOString()}] Concluído: ${updatedCount} atualizados, ${errorCount} erros`);
    
  } catch (error) {
    console.error(`💥 Erro geral na atualização:`, error);
  }
}

// Iniciar serviço de atualização
function startUpdateService() {
  console.log('🚀 Serviço iniciado - Atualização automática a cada 5 minutos');
  
  // Executar imediatamente ao iniciar
  updateAllDurations();
  
  // Configurar intervalo de 5 minutos
  setInterval(updateAllDurations, UPDATE_INTERVAL);
  
  console.log(`⏰ Próxima atualização automática em ${UPDATE_INTERVAL / 60000} minutos`);
}

// Rotas
app.get('/', (_req, res) => {
  res.json({ 
    status: 'Servidor rodando',
    boot_id: BOOT_ID,
    boards: BOARD_IDS,
    total_boards: BOARD_IDS.length,
    update_interval: '5 minutos',
    next_update: new Date(Date.now() + UPDATE_INTERVAL).toISOString(),
    endpoints: [
      'GET / - Status do serviço',
      'POST /force-update - Forçar atualização manual',
      'GET /boards - Lista de boards',
      'GET /test-board - Testar conexão com um board'
    ]
  });
});

app.post('/force-update', async (_req, res) => {
  console.log('📍 Atualização forçada solicitada');
  res.json({ 
    status: 'Atualização iniciada',
    boards: BOARD_IDS,
    timestamp: new Date().toISOString()
  });
  
  // Executar em background
  updateAllDurations().catch(error => {
    console.error('💥 Erro na atualização forçada:', error);
  });
});

app.get('/boards', (_req, res) => {
  res.json({
    boards: BOARD_IDS,
    count: BOARD_IDS.length
  });
});

// Rota de teste para verificar um board específico
app.get('/test-board/:boardId?', async (req, res) => {
  const boardId = req.params.boardId || BOARD_IDS[0];
  
  try {
    const query = `query {
      boards(ids: ${boardId}) {
        id
        name
        columns {
          id
          title
          type
        }
        items_page (query: {limit: 10}) {
          items {
            id
            name
            parent_item {
              id
              name
            }
            column_values {
              column {
                id
                title
              }
              text
            }
          }
        }
      }
    }`;
    
    const data = await gql(query);
    
    if (data.boards && data.boards.length > 0) {
      const board = data.boards[0];
      const items = board.items_page?.items || [];
      const subitems = items.filter(item => item.parent_item !== null);
      
      res.json({
        status: 'success',
        board: {
          id: board.id,
          name: board.name,
          columns: board.columns,
          total_items: items.length,
          total_subitems: subitems.length,
          subitems: subitems.slice(0, 5)
        }
      });
    } else {
      res.status(404).json({
        status: 'error',
        message: 'Board não encontrado'
      });
    }
    
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
  startUpdateService();
});