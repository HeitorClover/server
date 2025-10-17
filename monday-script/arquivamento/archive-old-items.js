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

// Vamos testar com APENAS 1 board primeiro
const BOARD_IDS = [7973161359];

const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`TEST BOARD: ${BOARD_IDS[0]}`);
console.log('--------------------------------------------');

// Função para fazer queries GraphQL
async function gql(query) {
  console.log(`🔍 Executando query: ${query.substring(0, 200)}...`);
  
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

// Rota para testar a conexão com o board
app.get('/test-board', async (_req, res) => {
  console.log('🧪 Testando conexão com o board...');
  
  try {
    // Query SIMPLES para testar
    const testQuery = `query {
      boards(ids: ${BOARD_IDS[0]}) {
        id
        name
        columns {
          id
          title
          type
        }
      }
    }`;
    
    console.log('📤 Enviando query de teste...');
    const data = await gql(testQuery);
    
    if (data.boards && data.boards.length > 0) {
      const board = data.boards[0];
      console.log(`✅ Board encontrado: "${board.name}" (ID: ${board.id})`);
      console.log(`📋 Colunas: ${board.columns.length} colunas encontradas`);
      
      res.json({
        status: 'success',
        board: {
          id: board.id,
          name: board.name,
          columns: board.columns.map(col => ({
            id: col.id,
            title: col.title,
            type: col.type
          }))
        }
      });
    } else {
      console.log('❌ Board não encontrado ou sem acesso');
      res.status(404).json({
        status: 'error',
        message: 'Board não encontrado ou sem acesso'
      });
    }
    
  } catch (error) {
    console.error('💥 Erro no teste:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Rota para testar busca de itens
app.get('/test-items', async (_req, res) => {
  console.log('🧪 Testando busca de itens...');
  
  try {
    // Query para buscar alguns itens
    const itemsQuery = `query {
      boards(ids: ${BOARD_IDS[0]}) {
        items(limit: 10) {
          id
          name
          column_values {
            column {
              id
              title
            }
            text
          }
        }
      }
    }`;
    
    console.log('📤 Enviando query de itens...');
    const data = await gql(itemsQuery);
    
    if (data.boards && data.boards.length > 0) {
      const board = data.boards[0];
      console.log(`✅ ${board.items.length} itens encontrados`);
      
      res.json({
        status: 'success',
        items_count: board.items.length,
        items: board.items.map(item => ({
          id: item.id,
          name: item.name,
          columns: item.column_values.map(cv => ({
            title: cv.column.title,
            value: cv.text
          }))
        }))
      });
    } else {
      res.status(404).json({
        status: 'error',
        message: 'Nenhum item encontrado'
      });
    }
    
  } catch (error) {
    console.error('💥 Erro na busca de itens:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Rota para testar busca de subitens
app.get('/test-subitems', async (_req, res) => {
  console.log('🧪 Testando busca de subitens...');
  
  try {
    // Query para buscar itens com parent_item (subitens)
    const subitemsQuery = `query {
      boards(ids: ${BOARD_IDS[0]}) {
        items(limit: 20) {
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
            value
          }
        }
      }
    }`;
    
    console.log('📤 Enviando query de subitens...');
    const data = await gql(subitemsQuery);
    
    if (data.boards && data.boards.length > 0) {
      const board = data.boards[0];
      const subitems = board.items.filter(item => item.parent_item !== null);
      const regularItems = board.items.filter(item => item.parent_item === null);
      
      console.log(`✅ ${subitems.length} subitens encontrados`);
      console.log(`📋 ${regularItems.length} itens regulares encontrados`);
      
      // Verificar colunas disponíveis nos subitens
      const availableColumns = subitems.length > 0 ? 
        subitems[0].column_values.map(cv => cv.column.title) : [];
      
      res.json({
        status: 'success',
        subitems_count: subitems.length,
        regular_items_count: regularItems.length,
        available_columns: availableColumns,
        subitems: subitems.slice(0, 5).map(item => ({
          id: item.id,
          name: item.name,
          parent: item.parent_item.name,
          columns: item.column_values.map(cv => ({
            title: cv.column.title,
            value: cv.text
          }))
        }))
      });
    } else {
      res.status(404).json({
        status: 'error',
        message: 'Nenhum subitem encontrado'
      });
    }
    
  } catch (error) {
    console.error('💥 Erro na busca de subitens:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Rotas básicas
app.get('/', (_req, res) => {
  res.json({ 
    status: 'Servidor de teste rodando',
    boot_id: BOOT_ID,
    test_board: BOARD_IDS[0],
    endpoints: [
      '/test-board - Testar conexão com o board',
      '/test-items - Testar busca de itens',
      '/test-subitems - Testar busca de subitens'
    ]
  });
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor de teste rodando na porta ${PORT}`);
  console.log(`🧪 Acesse os endpoints de teste para diagnosticar o problema`);
});