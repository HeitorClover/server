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

// Função para verificar arquivos na coluna DOCUMENTOS (CORRIGIDA)
async function checkDocumentos(itemId) {
  try {
    console.log(`📁 Verificando arquivos na coluna DOCUMENTOS do item ${itemId}`);
    
    const query = `query {
      items(ids: ${itemId}) {
        id
        name
        column_values {
          id
          column {
            title
          }
          value
          ... on FileValue {
            files {
              ... on FileAssetValue {
                id
                name
                url
              }
              ... on FileDocValue {
                id
                name
                url
              }
              ... on FileLinkValue {
                id
                name
                url
              }
            }
          }
        }
      }
    }`;
    
    const data = await gql(query);
    
    if (!data.items || data.items.length === 0) {
      console.log('❌ Item não encontrado');
      return null;
    }
    
    const item = data.items[0];
    
    // Encontrar a coluna DOCUMENTOS
    const documentosColumn = item.column_values.find(col => 
      col.column && col.column.title === 'DOCUMENTOS'
    );
    
    if (!documentosColumn) {
      console.log('❌ Coluna DOCUMENTOS não encontrada');
      return {
        itemName: item.name,
        hasDocumentosColumn: false,
        files: []
      };
    }
    
    console.log('✅ Coluna DOCUMENTOS encontrada');
    
    // Extrair informações dos arquivos - método correto
    let files = [];
    
    // Método 1: Tentar extrair dos fragments GraphQL
    if (documentosColumn.files && Array.isArray(documentosColumn.files)) {
      files = documentosColumn.files;
      console.log(`📊 Encontrados ${files.length} arquivo(s) via fragment GraphQL`);
    } 
    // Método 2: Tentar extrair do campo value (fallback)
    else if (documentosColumn.value) {
      try {
        const valueObj = JSON.parse(documentosColumn.value);
        if (valueObj.files && Array.isArray(valueObj.files)) {
          files = valueObj.files;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value`);
        } else if (valueObj && Array.isArray(valueObj)) {
          files = valueObj;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via array value`);
        }
      } catch (e) {
        console.log('ℹ️  Não foi possível extrair arquivos do campo value');
      }
    }
    
    // Garantir que temos informações básicas dos arquivos
    const processedFiles = files.map(file => ({
      id: file.id || 'unknown',
      name: file.name || 'arquivo_sem_nome',
      url: file.url || ''
    }));
    
    // Formatar resposta
    const result = {
      itemName: item.name,
      hasDocumentosColumn: true,
      totalFiles: processedFiles.length,
      files: processedFiles,
      fileNames: processedFiles.map(file => file.name),
      hasArtPdf: processedFiles.some(file => file.name && file.name.toLowerCase().includes('art.pdf'))
    };
    
    console.log(`📋 Arquivos encontrados: ${result.fileNames.join(', ')}`);
    console.log(`🎨 Tem ART.pdf: ${result.hasArtPdf}`);
    
    return result;
    
  } catch (error) {
    console.error('❌ Erro ao verificar documentos:', error);
    throw error;
  }
}

// Função para buscar subitens pelo nome
async function findSubitemByName(parentItemId, subitemName) {
  try {
    console.log(`🔍 Buscando subitem "${subitemName}" no item ${parentItemId}`);
    
    const query = `query {
      items(ids: ${parentItemId}) {
        subitems {
          id
          name
          board {
            id
            columns { id title type }
          }
          column_values {
            id
            column {
              id
              title
              type
            }
            value
            text
          }
        }
      }
    }`;
    
    const data = await gql(query);
    
    if (!data.items || data.items.length === 0 || !data.items[0].subitems) {
      console.log('❌ Nenhum subitem encontrado');
      return null;
    }
    
    const subitems = data.items[0].subitems;
    console.log(`📋 Encontrados ${subitems.length} subitens`);
    
    // Procurar pelo subitem com nome exato "ABRIR O. S."
    const targetSubitem = subitems.find(subitem => 
      subitem.name && subitem.name.trim() === 'ABRIR O. S.'
    );
    
    if (targetSubitem) {
      console.log(`✅ Subitem "${subitemName}" encontrado: ID ${targetSubitem.id}`);
      
      // Encontrar a coluna "CONCLUIDO"
      const concluidoColumn = targetSubitem.column_values.find(col => 
        col.column && col.column.title === 'CONCLUIDO'
      );
      
      return {
        subitem: targetSubitem,
        concluidoColumn: concluidoColumn
      };
    } else {
      console.log(`❌ Subitem "${subitemName}" não encontrado`);
      console.log(`📋 Subitens disponíveis: ${subitems.map(s => s.name).join(', ')}`);
      return null;
    }
    
  } catch (error) {
    console.error('❌ Erro ao buscar subitens:', error);
    throw error;
  }
}

// Função para marcar coluna CONCLUIDO como verdadeira
async function markConcluido(subitemId, boardId, columnId) {
  try {
    console.log(`✅ Marcando coluna CONCLUIDO como verdadeira no subitem ${subitemId}`);
    
    // Para colunas do tipo "checkbox" usamos o formato JSON correto
    const mutation = `mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${subitemId},
        column_id: "${columnId}",
        value: "{\\"checked\\":true}"
      ) { id }
    }`;
    
    console.log(`📤 Enviando mutation para marcar como concluído`);
    
    const result = await gql(mutation);
    console.log(`✅ Coluna CONCLUIDO marcada com sucesso!`);
    return result;
    
  } catch (error) {
    console.error('❌ Erro ao marcar como concluído:', error);
    
    // Tentar método alternativo
    console.log('🔄 Tentando método alternativo...');
    return await markConcluidoAlternative(subitemId, boardId, columnId);
  }
}

// Método alternativo para marcar como concluído
async function markConcluidoAlternative(subitemId, boardId, columnId) {
  try {
    // Método alternativo para diferentes tipos de coluna
    const mutation = `mutation {
      change_simple_column_value(
        board_id: ${boardId},
        item_id: ${subitemId},
        column_id: "${columnId}",
        value: "{\\"checked\\":\\"true\\"}"
      ) { id }
    }`;
    
    console.log(`📤 Enviando mutation alternativa para marcar como concluído`);
    
    const result = await gql(mutation);
    console.log(`✅ Coluna CONCLUIDO marcada com sucesso (método alternativo)!`);
    return result;
    
  } catch (error) {
    console.error('❌ Erro no método alternativo:', error);
    
    // Última tentativa com valor simples
    try {
      const simpleMutation = `mutation {
        change_simple_column_value(
          board_id: ${boardId},
          item_id: ${subitemId},
          column_id: "${columnId}",
          value: "true"
        ) { id }
      }`;
      
      console.log(`📤 Tentando método simples...`);
      const result = await gql(simpleMutation);
      console.log(`✅ Coluna CONCLUIDO marcada com sucesso (método simples)!`);
      return result;
    } catch (finalError) {
      console.error('❌ Todos os métodos falharam:', finalError);
      throw finalError;
    }
  }
}

// Processar webhook do Monday para DOCUMENTOS
async function processDocumentosWebhook(body) {
  console.log('📦 Webhook DOCUMENTOS recebido - Iniciando processamento...');
  
  try {
    const event = body.event;
    const itemId = event.pulseId;
    
    if (!itemId) {
      console.log('❌ Item ID não encontrado no evento');
      return;
    }
    
    console.log(`🔍 Processando item: ${itemId}`);
    
    // 1. Verificar os arquivos na coluna DOCUMENTOS
    const documentosInfo = await checkDocumentos(itemId);
    
    if (!documentosInfo || !documentosInfo.hasDocumentosColumn) {
      console.log('❌ Informações de documentos não disponíveis');
      return;
    }
    
    console.log(`📊 RESUMO DOCUMENTOS:`);
    console.log(`   Item: ${documentosInfo.itemName}`);
    console.log(`   Total de arquivos: ${documentosInfo.totalFiles}`);
    console.log(`   Tem ART.pdf: ${documentosInfo.hasArtPdf}`);
    
    if (documentosInfo.totalFiles > 0) {
      console.log(`   Arquivos: ${documentosInfo.fileNames.join(', ')}`);
    }
    
    // 2. Verificar condições: 2 arquivos E um deles é ART.pdf
    if (documentosInfo.totalFiles === 2 && documentosInfo.hasArtPdf) {
      console.log('🎯 CONDIÇÃO ATENDIDA: 2 documentos e um deles é ART.pdf');
      
      // 3. Procurar o subitem "ABRIR O. S."
      const subitemInfo = await findSubitemByName(itemId, 'ABRIR O. S.');
      
      if (subitemInfo && subitemInfo.subitem && subitemInfo.concluidoColumn) {
        console.log('✅ Subitem e coluna CONCLUIDO encontrados');
        
        // 4. Marcar a coluna CONCLUIDO como verdadeira
        await markConcluido(
          subitemInfo.subitem.id,
          subitemInfo.subitem.board.id,
          subitemInfo.concluidoColumn.column.id
        );
        
        console.log('🎉 PROCESSO CONCLUÍDO: Subitem ABRIR O. S. marcado como CONCLUIDO!');
        
      } else {
        console.log('❌ Subitem ABRIR O. S. ou coluna CONCLUIDO não encontrados');
        if (subitemInfo && subitemInfo.subitem && !subitemInfo.concluidoColumn) {
          console.log('⚠️  Subitem encontrado mas coluna CONCLUIDO não existe');
        }
      }
      
    } else {
      console.log('ℹ️  Condição não atendida:');
      console.log(`   - Esperado: 2 arquivos | Encontrado: ${documentosInfo.totalFiles}`);
      console.log(`   - Esperado: ART.pdf presente | Encontrado: ${documentosInfo.hasArtPdf}`);
    }
    
    console.log('✅ Processamento do webhook DOCUMENTOS concluído!');
    
  } catch (error) {
    console.error('❌ Erro ao processar webhook DOCUMENTOS:', error);
    console.error('Stack trace:', error.stack);
  }
}

// Rota webhook principal
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
  
  // Processar o webhook em segundo plano apenas se for da coluna DOCUMENTOS
  if (body.event && body.event.columnTitle === 'DOCUMENTOS') {
    console.log('🔄 Iniciando processamento DOCUMENTOS em background...');
    processDocumentosWebhook(body).catch(error => {
      console.error('💥 Erro não tratado no processamento do webhook:', error);
    });
  } else {
    console.log('ℹ️  Webhook não é da coluna DOCUMENTOS, ignorando...');
  }
});

// Rota para teste manual
app.post('/test-documentos', async (req, res) => {
  try {
    console.log('📍 POST /test-documentos recebido');
    const { itemId } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: 'itemId é obrigatório' });
    }
    
    // Simular o processamento completo
    const result = {
      itemId: itemId,
      steps: []
    };
    
    // 1. Verificar documentos
    const documentosInfo = await checkDocumentos(itemId);
    result.documentosInfo = documentosInfo;
    result.steps.push('Verificação de documentos concluída');
    
    if (documentosInfo && documentosInfo.hasDocumentosColumn) {
      // 2. Verificar condições
      const conditionMet = documentosInfo.totalFiles === 2 && documentosInfo.hasArtPdf;
      result.conditionMet = conditionMet;
      result.steps.push(`Condição atendida: ${conditionMet}`);
      
      if (conditionMet) {
        // 3. Buscar subitem
        const subitemInfo = await findSubitemByName(itemId, 'ABRIR O. S.');
        result.subitemInfo = subitemInfo;
        result.steps.push('Busca por subitem concluída');
        
        if (subitemInfo && subitemInfo.subitem && subitemInfo.concluidoColumn) {
          // 4. Marcar como concluído (apenas em teste não executa de verdade)
          result.steps.push('SIMULAÇÃO: Subitem seria marcado como CONCLUIDO');
          result.wouldMarkConcluido = true;
        }
      }
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Erro em /test-documentos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
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

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));