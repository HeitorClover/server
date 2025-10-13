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

// Função para formatar CPF
function formatCPF(cpf) {
  if (!cpf) return cpf;
  
  // Se for um objeto, extrai o valor
  if (typeof cpf === 'object' && cpf.value) {
    cpf = cpf.value;
  }
  
  const numbersOnly = String(cpf).replace(/\D/g, '');
  
  // Verifica se tem 11 dígitos
  if (numbersOnly.length !== 11) {
    console.log(`⚠️ CPF não tem 11 dígitos: ${numbersOnly} (${numbersOnly.length} dígitos)`);
    return cpf; // Retorna original se não tiver 11 dígitos
  }
  
  // Formata: XXX.XXX.XXX-XX
  const formatted = numbersOnly.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  console.log(`✅ CPF formatado: ${numbersOnly} -> ${formatted}`);
  return formatted;
}

// Função para extrair o valor do CPF do objeto do Monday
function extractCPFValue(value) {
  console.log(`🔍 Extraindo valor do CPF:`, JSON.stringify(value));
  
  if (typeof value === 'object' && value !== null) {
    // Tenta diferentes propriedades que o Monday pode usar
    if (value.value !== undefined) {
      return value.value;
    } else if (value.text !== undefined) {
      return value.text;
    } else {
      // Se for objeto mas não tem propriedades conhecidas, converte para string
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

// Função para atualizar o CPF formatado
async function updateFormattedCPF(itemId, boardId, columnId, formattedCPF) {
  // Para colunas de texto, enviamos como string simples
  const mutation = `mutation {
    change_column_value(
      board_id: ${boardId},
      item_id: ${itemId},
      column_id: "${columnId}",
      value: "${formattedCPF}"
    ) { id }
  }`;
  
  try {
    console.log(`🔄 Atualizando CPF para: ${formattedCPF}`);
    const result = await gql(mutation);
    console.log(`✅ CPF formatado atualizado com sucesso: ${formattedCPF}`);
    return result;
  } catch (error) {
    console.error('❌ Erro ao atualizar CPF:', error);
    throw error;
  }
}

// Função para obter informações do item
async function getItemInfo(itemId) {
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
    }
  }`;
  
  console.log(`🔍 Buscando informações do item ${itemId}`);
  const data = await gql(query);
  
  if (!data.items || data.items.length === 0) {
    console.error(`❌ Item ${itemId} não encontrado`);
    return null;
  }
  
  const item = data.items[0];
  console.log(`📋 Item encontrado: "${item.name}" no board ${item.board.id}`);
  return item;
}

// Processar webhook do Monday
async function processWebhook(body) {
  console.log('📦 Webhook recebido - Iniciando processamento...');
  
  try {
    const event = body.event;
    
    if (!event) {
      console.log('❌ Nenhum evento encontrado no body');
      return;
    }
    
    console.log(`🔍 Tipo de evento: ${event.type}`);
    console.log(`🔍 Coluna alterada: "${event.columnTitle}"`);

    // Verificar se é uma mudança na coluna CPF
    if (event.type === 'update_column_value') {
      console.log('📋 Evento de atualização de coluna detectado');
      
      const itemId = event.pulseId;
      const columnId = event.columnId;
      const rawValue = event.value;
      
      console.log(`📊 Item ID: ${itemId}, Column ID: ${columnId}`);
      console.log(`📊 Valor bruto:`, JSON.stringify(rawValue));
      
      if (!itemId) {
        console.log('❌ Item ID não encontrado no evento');
        return;
      }
      
      // Verificar se a coluna alterada é a coluna CPF
      if (event.columnTitle.toLowerCase() !== 'cpf') {
        console.log(`⚠️  Mudança não foi na coluna CPF, mas sim em: "${event.columnTitle}"`);
        return;
      }
      
      console.log(`🎯 Coluna CPF detectada!`);
      
      // Extrair o valor real do CPF do objeto
      const cpfValue = extractCPFValue(rawValue);
      console.log(`📝 Valor extraído do CPF: ${cpfValue}`);
      
      // Formatando o CPF
      const formattedCPF = formatCPF(cpfValue);
      
      // Verificar se o CPF já está formatado (para evitar loop)
      if (formattedCPF === cpfValue) {
        console.log('ℹ️  CPF já está formatado, nenhuma ação necessária');
        return;
      }
      
      console.log(`🔧 Formatando CPF: ${cpfValue} -> ${formattedCPF}`);
      
      // Obter informações do item para pegar o boardId
      const itemInfo = await getItemInfo(itemId);
      
      if (!itemInfo) {
        console.log('❌ Não foi possível obter informações do item');
        return;
      }
      
      // Atualizar com o CPF formatado
      await updateFormattedCPF(
        itemId, 
        itemInfo.board.id, 
        columnId, 
        formattedCPF
      );
      
      console.log('✅ Processamento do webhook concluído com sucesso!');
      
    } else {
      console.log(`⚠️  Tipo de evento não suportado: ${event.type}`);
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

// Rota de debug para testar manualmente
app.post('/test-cpf', (req, res) => {
  console.log('📍 POST /test-cpf recebido');
  const { cpf } = req.body;
  const formatted = formatCPF(cpf);
  res.json({ original: cpf, formatted: formatted });
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));

// Log periódico para verificar se o servidor está vivo
setInterval(() => {
  console.log(`❤️  Servidor vivo - ${new Date().toISOString()}`);
}, 300000); // A cada 5 minutos