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

// Função para formatar telefone
function formatPhone(phone) {
  if (!phone) return phone;
  
  // Se for um objeto, extrai o valor
  if (typeof phone === 'object' && phone.value) {
    phone = phone.value;
  }
  
  const numbersOnly = String(phone).replace(/\D/g, '');
  
  console.log(`📱 Formatando telefone: ${numbersOnly} (${numbersOnly.length} dígitos)`);
  
  // Verifica o tamanho do número
  if (numbersOnly.length === 13) {
    // Formato: 5588998685336 -> +55 (88) 99868-5336
    const formatted = `+${numbersOnly.substring(0, 2)} (${numbersOnly.substring(2, 4)}) ${numbersOnly.substring(4, 9)}-${numbersOnly.substring(9)}`;
    console.log(`✅ Telefone formatado: ${numbersOnly} -> ${formatted}`);
    return formatted;
  } else if (numbersOnly.length === 11) {
    // Formato: 88998685336 -> (88) 99868-5336
    const formatted = `(${numbersOnly.substring(0, 2)}) ${numbersOnly.substring(2, 7)}-${numbersOnly.substring(7)}`;
    console.log(`✅ Telefone formatado: ${numbersOnly} -> ${formatted}`);
    return formatted;
  } else if (numbersOnly.length === 10) {
    // Formato: 8899368533 -> (88) 9936-8533
    const formatted = `(${numbersOnly.substring(0, 2)}) ${numbersOnly.substring(2, 6)}-${numbersOnly.substring(6)}`;
    console.log(`✅ Telefone formatado: ${numbersOnly} -> ${formatted}`);
    return formatted;
  } else {
    console.log(`⚠️ Telefone não tem formato reconhecido: ${numbersOnly} (${numbersOnly.length} dígitos)`);
    return phone; // Retorna original se não tiver formato reconhecido
  }
}

// Função para extrair o valor do objeto do Monday
function extractValue(value) {
  console.log(`🔍 Extraindo valor:`, JSON.stringify(value));
  
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

// Função para atualizar o valor formatado
async function updateFormattedValue(itemId, boardId, columnId, formattedValue) {
  try {
    console.log(`🔄 Atualizando valor para: ${formattedValue}`);
    
    // Para colunas de texto, enviamos o valor diretamente como string
    const mutation = `mutation {
      change_simple_column_value(
        board_id: ${boardId},
        item_id: ${itemId},
        column_id: "${columnId}",
        value: "${formattedValue.replace(/"/g, '\\"')}"
      ) { id }
    }`;
    
    console.log(`📤 Enviando mutation:`, mutation);
    
    const result = await gql(mutation);
    console.log(`✅ Valor formatado atualizado com sucesso: ${formattedValue}`);
    return result;
  } catch (error) {
    console.error('❌ Erro ao atualizar valor:', error);
    
    // Tentar método alternativo se o primeiro falhar
    console.log('🔄 Tentando método alternativo...');
    return await updateFormattedValueAlternative(itemId, boardId, columnId, formattedValue);
  }
}

// Método alternativo para atualizar coluna de texto
async function updateFormattedValueAlternative(itemId, boardId, columnId, formattedValue) {
  try {
    // Método alternativo usando change_column_value com valor direto
    const mutation = `mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${itemId},
        column_id: "${columnId}",
        value: "${formattedValue.replace(/"/g, '\\"')}"
      ) { id }
    }`;
    
    console.log(`📤 Enviando mutation alternativa:`, mutation);
    
    const result = await gql(mutation);
    console.log(`✅ Valor formatado atualizado com sucesso (método alternativo): ${formattedValue}`);
    return result;
  } catch (error) {
    console.error('❌ Erro no método alternativo:', error);
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

    // Verificar se é uma mudança em coluna que queremos formatar
    if (event.type === 'update_column_value') {
      console.log('📋 Evento de atualização de coluna detectado');
      
      const itemId = event.pulseId;
      const columnId = event.columnId;
      const rawValue = event.value;
      const columnTitle = event.columnTitle;
      
      console.log(`📊 Item ID: ${itemId}, Column ID: ${columnId}`);
      console.log(`📊 Valor bruto:`, JSON.stringify(rawValue));
      
      if (!itemId) {
        console.log('❌ Item ID não encontrado no evento');
        return;
      }
      
      // Extrair o valor real do objeto
      const extractedValue = extractValue(rawValue);
      console.log(`📝 Valor extraído: ${extractedValue}`);
      
      let formattedValue;
      let shouldUpdate = false;
      
      // Verificar qual coluna foi alterada e aplicar formatação correspondente
      if (columnTitle.toLowerCase() === 'cpf') {
        console.log(`🎯 Coluna CPF detectada!`);
        
        // Formatando o CPF
        formattedValue = formatCPF(extractedValue);
        
        // Verificar se o CPF já está formatado (para evitar loop)
        if (formattedValue !== extractedValue) {
          shouldUpdate = true;
          console.log(`🔧 Formatando CPF: ${extractedValue} -> ${formattedValue}`);
        } else {
          console.log('ℹ️  CPF já está formatado, nenhuma ação necessária');
        }
        
      } else if (columnTitle.toLowerCase().includes('número') || 
                 columnTitle.toLowerCase().includes('numero') ||
                 columnTitle.toLowerCase().includes('telefone') ||
                 columnTitle.toLowerCase().includes('celular') ||
                 columnTitle.toLowerCase().includes('phone')) {
        
        console.log(`🎯 Coluna de telefone detectada: "${columnTitle}"`);
        
        // Formatando o telefone
        formattedValue = formatPhone(extractedValue);
        
        // Verificar se o telefone já está formatado (para evitar loop)
        if (formattedValue !== extractedValue) {
          shouldUpdate = true;
          console.log(`🔧 Formatando telefone: ${extractedValue} -> ${formattedValue}`);
        } else {
          console.log('ℹ️  Telefone já está formatado, nenhuma ação necessária');
        }
      } else {
        console.log(`⚠️  Coluna não suportada: "${columnTitle}"`);
        return;
      }
      
      // Se precisamos atualizar, prosseguir com a atualização
      if (shouldUpdate) {
        // Obter informações do item para pegar o boardId
        const itemInfo = await getItemInfo(itemId);
        
        if (!itemInfo) {
          console.log('❌ Não foi possível obter informações do item');
          return;
        }
        
        // Atualizar com o valor formatado
        await updateFormattedValue(
          itemId, 
          itemInfo.board.id, 
          columnId, 
          formattedValue
        );
        
        console.log('✅ Processamento do webhook concluído com sucesso!');
      }
      
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

// Rota de debug para testar manualmente telefone
app.post('/test-phone', (req, res) => {
  console.log('📍 POST /test-phone recebido');
  const { phone } = req.body;
  const formatted = formatPhone(phone);
  res.json({ original: phone, formatted: formatted });
});

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));

// Log periódico para verificar se o servidor está vivo
setInterval(() => {
  console.log(`❤️  Servidor vivo - ${new Date().toISOString()}`);
}, 300000); // A cada 5 minutos