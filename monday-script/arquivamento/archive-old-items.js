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

const BOOT_ID = process.env.BOOT_ID || `boot-${Date.now()}`;

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
console.log(`BOOT_ID: ${BOOT_ID}`);
console.log(`PID: ${process.pid}`);
console.log('--------------------------------------------');

// Função para extrair data e hora do formato do Monday
function extractMondayDate(dateValue) {
  console.log(`📅 Extraindo data do Monday:`, dateValue);
  
  if (!dateValue) {
    return null;
  }
  
  try {
    // Se for string, tenta parsear como JSON
    if (typeof dateValue === 'string') {
      const dateObj = JSON.parse(dateValue);
      if (dateObj && dateObj.date && dateObj.time) {
        const dateTimeString = `${dateObj.date}T${dateObj.time}`;
        console.log(`✅ Data extraída: ${dateTimeString}`);
        return dateTimeString;
      }
    }
    // Se já for objeto
    else if (typeof dateValue === 'object' && dateValue.date && dateValue.time) {
      const dateTimeString = `${dateValue.date}T${dateValue.time}`;
      console.log(`✅ Data extraída: ${dateTimeString}`);
      return dateTimeString;
    }
  } catch (error) {
    console.log('❌ Erro ao extrair data do Monday:', error);
  }
  
  return null;
}

// Função para calcular diferença entre datas e formatar
function calculateAndFormatDateDifference(startDateValue, endDateValue) {
  console.log(`📅 Calculando diferença entre datas:`);
  
  const startDate = extractMondayDate(startDateValue);
  const endDate = extractMondayDate(endDateValue);
  
  console.log(`   Início: ${startDate}`);
  console.log(`   Fim: ${endDate}`);
  
  if (!startDate || !endDate) {
    console.log('⚠️  Uma ou ambas as datas estão vazias ou inválidas');
    return 'Datas incompletas';
  }
  
  try {
    // Converter as datas para objetos Date
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      console.log('❌ Datas inválidas após conversão');
      return 'Datas inválidas';
    }
    
    // Calcular diferença em milissegundos
    const diffMs = end - start;
    
    if (diffMs < 0) {
      return 'Data final anterior à inicial';
    }
    
    // Calcular dias, horas, minutos e segundos
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    // Formatar a string
    let result = '';
    if (days > 0) result += `${days} dias, `;
    if (hours > 0) result += `${hours} horas, `;
    if (minutes > 0) result += `${minutes} minutos, `;
    result += `${seconds} segundos`;
    
    console.log(`✅ Diferença calculada: ${result}`);
    return result;
    
  } catch (error) {
    console.error('❌ Erro ao calcular diferença de datas:', error);
    return 'Erro no cálculo';
  }
}

// Função para extrair o valor do objeto do Monday
function extractValue(value) {
  console.log(`🔍 Extraindo valor:`, JSON.stringify(value));
  
  if (typeof value === 'object' && value !== null) {
    if (value.value !== undefined) {
      return value.value;
    } else if (value.text !== undefined) {
      return value.text;
    } else if (value.date !== undefined) {
      return value;
    } else {
      return String(value);
    }
  }
  
  return value;
}

// Função para fazer queries GraphQL
async function gql(query) {
  console.log(`🔍 Executando query: ${query.substring(0, 100)}...`);
  
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
    console.log(`🔄 Atualizando coluna DURAÇÃO: "${durationText}"`);
    
    // Para coluna de texto, usamos change_simple_column_value
    const mutation = `mutation {
      change_simple_column_value(
        board_id: ${boardId},
        item_id: ${itemId},
        column_id: "${columnId}",
        value: "${durationText.replace(/"/g, '\\"')}"
      ) { id }
    }`;
    
    console.log(`📤 Enviando mutation para atualizar DURAÇÃO`);
    
    const result = await gql(mutation);
    console.log(`✅ DURAÇÃO atualizada com sucesso: ${durationText}`);
    return result;
  } catch (error) {
    console.error('❌ Erro ao atualizar DURAÇÃO:', error);
    throw error;
  }
}

// Função para obter informações do SUBITEM
async function getSubitemInfo(itemId) {
  const query = `query {
    items(ids: ${itemId}) {
      id
      name
      board {
        id
        columns { id title type }
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
  }`;
  
  console.log(`🔍 Buscando informações do subitem ${itemId}`);
  const data = await gql(query);
  
  if (!data.items || data.items.length === 0) {
    console.error(`❌ Subitem ${itemId} não encontrado`);
    return null;
  }
  
  const item = data.items[0];
  console.log(`📋 Subitem encontrado: "${item.name}"`);
  console.log(`📋 Item pai: ${item.parent_item ? item.parent_item.name : 'N/A'}`);
  return item;
}

// Função para encontrar coluna pelo título exato
function findColumnByTitle(columns, title) {
  const found = columns.find(col => 
    col.column.title.toLowerCase() === title.toLowerCase()
  );
  
  if (found) {
    console.log(`✅ Coluna encontrada: "${found.column.title}" (${found.column.id})`);
  } else {
    console.log(`❌ Coluna não encontrada: "${title}"`);
  }
  
  return found;
}

// Processar webhook do Monday para SUBITENS
async function processWebhook(body) {
  console.log('📦 Webhook recebido - Iniciando processamento para SUBITEM...');
  
  try {
    const event = body.event;
    
    if (!event) {
      console.log('❌ Nenhum evento encontrado no body');
      return;
    }
    
    console.log(`🔍 Tipo de evento: ${event.type}`);
    console.log(`🔍 Coluna alterada: "${event.columnTitle}"`);

    // Verificar se é uma mudança na coluna FINALIZAÇÃO
    if (event.type === 'update_column_value' && 
        event.columnTitle.toLowerCase().includes('finalização')) {
      
      console.log('🎯 Coluna FINALIZAÇÃO alterada em SUBITEM!');
      
      const subitemId = event.pulseId;
      const rawValue = event.value;
      
      console.log(`📊 Subitem ID: ${subitemId}`);
      
      if (!subitemId) {
        console.log('❌ Subitem ID não encontrado no evento');
        return;
      }
      
      // Obter informações completas do SUBITEM
      const subitemInfo = await getSubitemInfo(subitemId);
      
      if (!subitemInfo) {
        console.log('❌ Não foi possível obter informações do subitem');
        return;
      }
      
      // Encontrar as colunas INICIO, FINALIZAÇÃO e DURAÇÃO
      const inicioColumn = findColumnByTitle(subitemInfo.column_values, 'INICIO');
      const finalizacaoColumn = findColumnByTitle(subitemInfo.column_values, 'FINALIZAÇÃO');
      const duracaoColumn = findColumnByTitle(subitemInfo.column_values, 'DURAÇÃO');
      
      if (!inicioColumn || !finalizacaoColumn) {
        console.log('❌ Colunas INICIO e/ou FINALIZAÇÃO não encontradas no subitem');
        return;
      }
      
      if (!duracaoColumn) {
        console.log('❌ Coluna DURAÇÃO não encontrada no subitem. Crie uma coluna de texto com esse nome.');
        return;
      }
      
      // Extrair valores das datas (agora mantemos o objeto completo para extractMondayDate)
      const inicioValue = extractValue(inicioColumn.value);
      const finalizacaoValue = extractValue(finalizacaoColumn.value);
      
      console.log(`📅 Data INICIO bruta:`, inicioValue);
      console.log(`📅 Data FINALIZAÇÃO bruta:`, finalizacaoValue);
      
      // Calcular diferença formatada
      const durationText = calculateAndFormatDateDifference(inicioValue, finalizacaoValue);
      
      // Atualizar coluna DURAÇÃO
      await updateDurationColumn(
        subitemId, 
        subitemInfo.board.id, 
        duracaoColumn.column.id, 
        durationText
      );
      
      console.log('✅ Processamento do webhook para SUBITEM concluído com sucesso!');
      
    } else {
      console.log(`⚠️  Evento ignorado: não é alteração na coluna FINALIZAÇÃO`);
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error);
    console.error('Stack trace:', error.stack);
  }
}

// Rota webhook
app.post('/webhook', (req, res) => {
  console.log('📍 POST /webhook recebido');
  
  const body = req.body || {};
  
  // Responder imediatamente para o Monday
  if (body.challenge) {
    console.log('🔐 Challenge recebido:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }
  
  console.log('✅ Respondendo 200 OK para Monday');
  res.status(200).json({ ok: true, boot: BOOT_ID, received: true });
  
  // Processar o webhook em segundo plano
  console.log('🔄 Iniciando processamento em background...');
  processWebhook(body).catch(error => {
    console.error('💥 Erro não tratado no processamento do webhook:', error);
  });
});

// Rota de health check
app.get('/', (_req, res) => {
  console.log('📍 GET / recebido');
  res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`);
});

app.get('/webhook', (_req, res) => {
  console.log('📍 GET /webhook recebido');
  res.json({ 
    status: 'ok', 
    now: new Date().toISOString(), 
    boot_id: BOOT_ID,
    message: 'Webhook endpoint está funcionando'
  });
});

// Rota de debug para testar cálculo de datas
app.post('/test-dates', (req, res) => {
  console.log('📍 POST /test-dates recebido');
  const { inicio, finalizacao } = req.body;
  const duration = calculateAndFormatDateDifference(inicio, finalizacao);
  res.json({ 
    inicio: inicio, 
    finalizacao: finalizacao, 
    duracao: duration 
  });
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));