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
  // Remove tudo que não é número
  const numbersOnly = cpf.replace(/\D/g, '');
  
  // Verifica se tem 11 dígitos
  if (numbersOnly.length !== 11) {
    return cpf; // Retorna original se não tiver 11 dígitos
  }
  
  // Formata: XXX.XXX.XXX-XX
  return numbersOnly.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
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
    console.error('Erro na query GraphQL:', data.errors);
    throw new Error('GraphQL error: ' + JSON.stringify(data.errors));
  }
  
  return data.data;
}

// Função para atualizar o CPF formatado
async function updateFormattedCPF(itemId, boardId, columnId, formattedCPF) {
  const mutation = `mutation {
    change_column_value(
      board_id: ${boardId},
      item_id: ${itemId},
      column_id: "${columnId}",
      value: "${formattedCPF}"
    ) { id }
  }`;
  
  try {
    const result = await gql(mutation);
    console.log(`✅ CPF formatado atualizado para: ${formattedCPF}`);
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
  
  const data = await gql(query);
  return data.items[0];
}

// Processar webhook do Monday
async function processWebhook(body) {
  try {
    console.log('📦 Webhook recebido:', JSON.stringify(body, null, 2));
    
    const event = body.event;
    
    if (!event) {
      console.log('❌ Evento não encontrado no body');
      return;
    }
    
    // Verificar se é uma mudança na coluna CPF
    if (event.type === 'update_column_value') {
      console.log('📋 Evento de atualização de coluna detectado');
      
      const itemId = event.pulseId || event.itemId;
      const columnId = event.columnId;
      const value = event.value;
      
      console.log(`Item ID: ${itemId}, Column ID: ${columnId}, Value: ${value}`);
      
      // Obter informações do item
      const itemInfo = await getItemInfo(itemId);
      
      if (!itemInfo) {
        console.log('❌ Item não encontrado');
        return;
      }
      
      // Encontrar a coluna CPF
      const cpfColumn = itemInfo.board.columns.find(col => 
        col.title && col.title.toLowerCase() === 'cpf'
      );
      
      if (!cpfColumn) {
        console.log('❌ Coluna CPF não encontrada no board');
        return;
      }
      
      // Verificar se a coluna alterada é a coluna CPF
      if (columnId !== cpfColumn.id) {
        console.log('⚠️  Mudança não foi na coluna CPF, ignorando...');
        return;
      }
      
      // Formatando o CPF
      const formattedCPF = formatCPF(value);
      
      // Verificar se o CPF já está formatado (para evitar loop)
      if (formattedCPF === value) {
        console.log('ℹ️  CPF já está formatado, nenhuma ação necessária');
        return;
      }
      
      console.log(`🔧 Formatando CPF: ${value} -> ${formattedCPF}`);
      
      // Atualizar com o CPF formatado
      await updateFormattedCPF(
        itemId, 
        itemInfo.board.id, 
        columnId, 
        formattedCPF
      );
      
      console.log('✅ CPF formatado com sucesso!');
    } else {
      console.log(`⚠️  Tipo de evento não suportado: ${event.type}`);
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error);
  }
}

// Rota webhook
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  
  // Responder imediatamente para o Monday
  if (body.challenge) {
    console.log('🔐 Challenge recebido:', body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }
  
  res.status(200).json({ ok: true, boot: BOOT_ID });
  
  // Processar o webhook em segundo plano
  processWebhook(body).catch(error => {
    console.error('Erro no processamento do webhook:', error);
  });
});

app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));
app.get('/webhook', (_req, res) => res.json({ 
  status: 'ok', 
  now: new Date().toISOString(), 
  boot_id: BOOT_ID 
}));

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));