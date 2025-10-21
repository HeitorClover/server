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

// Função para verificar arquivos na coluna PROJETOS
async function checkProjetos(itemId) {
  try {
    console.log(`📁 Verificando arquivos na coluna PROJETOS do item ${itemId}`);
    
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
          text
        }
      }
    }`;
    
    const data = await gql(query);
    
    if (!data.items || data.items.length === 0) {
      console.log('❌ Item não encontrado');
      return null;
    }
    
    const item = data.items[0];
    
    // Encontrar a coluna PROJETOS
    const projetosColumn = item.column_values.find(col => 
      col.column && col.column.title === 'PROJETOS'
    );
    
    if (!projetosColumn) {
      console.log('❌ Coluna PROJETOS não encontrada');
      return {
        itemName: item.name,
        hasProjetosColumn: false,
        files: []
      };
    }
    
    console.log('✅ Coluna PROJETOS encontrada');
    console.log(`📊 Valor da coluna: ${projetosColumn.value}`);
    console.log(`📊 Texto da coluna: ${projetosColumn.text}`);
    
    // Extrair informações dos arquivos do campo value
    let files = [];
    
    if (projetosColumn.value) {
      try {
        const valueObj = JSON.parse(projetosColumn.value);
        
        if (valueObj.files && Array.isArray(valueObj.files)) {
          files = valueObj.files;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value (files array)`);
        } else if (Array.isArray(valueObj)) {
          files = valueObj;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value (direct array)`);
        } else if (valueObj.assets && Array.isArray(valueObj.assets)) {
          files = valueObj.assets;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value (assets)`);
        }
      } catch (e) {
        console.log('ℹ️  Não foi possível extrair arquivos do campo value como JSON');
      }
    }
    
    // Garantir que temos informações básicas dos arquivos
    const processedFiles = files.map(file => ({
      id: file.id || file.assetId || file.asset_id || `file-${Date.now()}-${Math.random()}`,
      name: file.name || file.file_name || file.filename || 'arquivo_sem_nome',
      url: file.url || ''
    }));
    
    // Verificar condições específicas dos arquivos
    const hasArqPdf = processedFiles.some(file => 
      file.name && 
      file.name.toLowerCase().startsWith('arq') && 
      file.name.toLowerCase().endsWith('.pdf')
    );
    
    const hasHidroPdf = processedFiles.some(file => 
      file.name && 
      file.name.toLowerCase().startsWith('hidro') && 
      file.name.toLowerCase().endsWith('.pdf')
    );
    
    const hasMemoriaisPdf = processedFiles.some(file => 
      file.name && 
      file.name.toLowerCase().startsWith('memoriais') && 
      file.name.toLowerCase().endsWith('.pdf')
    );
    
    // Formatar resposta
    const result = {
      itemName: item.name,
      hasProjetosColumn: true,
      totalFiles: processedFiles.length,
      files: processedFiles,
      fileNames: processedFiles.map(file => file.name),
      hasArqPdf: hasArqPdf,
      hasHidroPdf: hasHidroPdf,
      hasMemoriaisPdf: hasMemoriaisPdf,
      allConditionsMet: hasArqPdf && hasHidroPdf && hasMemoriaisPdf && processedFiles.length === 3
    };
    
    console.log(`📋 Arquivos encontrados: ${result.fileNames.join(', ')}`);
    console.log(`📊 Condições:`);
    console.log(`   - ARQ*.pdf: ${hasArqPdf}`);
    console.log(`   - HIDRO*.pdf: ${hasHidroPdf}`);
    console.log(`   - MEMORIAIS*.pdf: ${hasMemoriaisPdf}`);
    console.log(`   - Total de 3 arquivos: ${processedFiles.length === 3}`);
    console.log(`   - TODAS CONDIÇÕES ATENDIDAS: ${result.allConditionsMet}`);
    
    return result;
    
  } catch (error) {
    console.error('❌ Erro ao verificar projetos:', error);
    throw error;
  }
}

// Função para verificar arquivos na coluna DOCUMENTAÇÃO (ATUALIZADA)
async function checkDocumentacao(itemId) {
  try {
    console.log(`📁 Verificando arquivos na coluna DOCUMENTAÇÃO do item ${itemId}`);
    
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
          text
        }
      }
    }`;
    
    const data = await gql(query);
    
    if (!data.items || data.items.length === 0) {
      console.log('❌ Item não encontrado');
      return null;
    }
    
    const item = data.items[0];
    
    // Encontrar a coluna DOCUMENTAÇÃO
    const documentacaoColumn = item.column_values.find(col => 
      col.column && col.column.title === 'DOCUMENTAÇÃO'
    );
    
    if (!documentacaoColumn) {
      console.log('❌ Coluna DOCUMENTAÇÃO não encontrada');
      return {
        itemName: item.name,
        hasDocumentacaoColumn: false,
        files: []
      };
    }
    
    console.log('✅ Coluna DOCUMENTAÇÃO encontrada');
    console.log(`📊 Valor da coluna: ${documentacaoColumn.value}`);
    console.log(`📊 Texto da coluna: ${documentacaoColumn.text}`);
    
    // Extrair informações dos arquivos do campo value
    let files = [];
    
    if (documentacaoColumn.value) {
      try {
        const valueObj = JSON.parse(documentacaoColumn.value);
        
        if (valueObj.files && Array.isArray(valueObj.files)) {
          files = valueObj.files;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value (files array)`);
        } else if (Array.isArray(valueObj)) {
          files = valueObj;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value (direct array)`);
        } else if (valueObj.assets && Array.isArray(valueObj.assets)) {
          files = valueObj.assets;
          console.log(`📊 Encontrados ${files.length} arquivo(s) via campo value (assets)`);
        }
      } catch (e) {
        console.log('ℹ️  Não foi possível extrair arquivos do campo value como JSON');
      }
    }
    
    // Garantir que temos informações básicas dos arquivos
    const processedFiles = files.map(file => ({
      id: file.id || file.assetId || file.asset_id || `file-${Date.now()}-${Math.random()}`,
      name: file.name || file.file_name || file.filename || 'arquivo_sem_nome',
      url: file.url || ''
    }));
    
    // Verificar condições específicas dos arquivos (ATUALIZADO)
    const hasMatrPdf = processedFiles.some(file => 
      file.name && 
      file.name.toLowerCase().startsWith('matr') && 
      file.name.toLowerCase().endsWith('.pdf')
    );
    
    const hasAlvarPdf = processedFiles.some(file => 
      file.name && 
      file.name.toLowerCase().startsWith('alvar') && 
      file.name.toLowerCase().endsWith('.pdf')
    );
    
    const hasHabitePdf = processedFiles.some(file => 
      file.name && 
      file.name.toLowerCase().startsWith('habite') && 
      file.name.toLowerCase().endsWith('.pdf')
    );
    
    // Determinar qual condição foi atendida e qual subitem procurar
    let targetSubitemName = null;
    let conditionType = null;
    
    if (hasMatrPdf) {
      targetSubitemName = 'DOC - AB MATRICULA';
      conditionType = 'MATR';
    } else if (hasAlvarPdf) {
      targetSubitemName = 'DOC - EMITIR ALVARÁ';
      conditionType = 'ALVAR';
    } else if (hasHabitePdf) {
      targetSubitemName = 'DOC - HABITE-SE IMÓVEL';
      conditionType = 'HABITE';
    }
    
    // Formatar resposta
    const result = {
      itemName: item.name,
      hasDocumentacaoColumn: true,
      totalFiles: processedFiles.length,
      files: processedFiles,
      fileNames: processedFiles.map(file => file.name),
      hasMatrPdf: hasMatrPdf,
      hasAlvarPdf: hasAlvarPdf,
      hasHabitePdf: hasHabitePdf,
      conditionMet: hasMatrPdf || hasAlvarPdf || hasHabitePdf,
      targetSubitemName: targetSubitemName,
      conditionType: conditionType
    };
    
    console.log(`📋 Arquivos encontrados: ${result.fileNames.join(', ')}`);
    console.log(`📊 Condições:`);
    console.log(`   - MATR*.pdf: ${hasMatrPdf}`);
    console.log(`   - ALVAR*.pdf: ${hasAlvarPdf}`);
    console.log(`   - HABITE*.pdf: ${hasHabitePdf}`);
    console.log(`   - Subitem alvo: ${targetSubitemName}`);
    
    return result;
    
  } catch (error) {
    console.error('❌ Erro ao verificar documentação:', error);
    throw error;
  }
}

// Função para buscar subitens pelo nome (com busca flexível)
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
    console.log(`📋 Encontrados ${subitems.length} subitens: ${subitems.map(s => s.name).join(', ')}`);
    
    // Busca flexível - remove espaços extras e compara
    const targetSubitem = subitems.find(subitem => {
      if (!subitem.name) return false;
      
      // Normaliza os nomes removendo espaços extras para comparação
      const normalizedSubitemName = subitem.name.replace(/\s+/g, ' ').trim();
      const normalizedTargetName = subitemName.replace(/\s+/g, ' ').trim();
      
      return normalizedSubitemName === normalizedTargetName;
    });
    
    if (targetSubitem) {
      console.log(`✅ Subitem "${subitemName}" encontrado: ID ${targetSubitem.id} (nome original: "${targetSubitem.name}")`);
      
      // Encontrar a coluna "CONCLUIDO"
      const concluidoColumn = targetSubitem.column_values.find(col => 
        col.column && col.column.title === 'CONCLUIDO'
      );
      
      if (concluidoColumn) {
        console.log(`✅ Coluna CONCLUIDO encontrada: ID ${concluidoColumn.column.id}`);
      } else {
        console.log('❌ Coluna CONCLUIDO não encontrada no subitem');
        console.log(`📋 Colunas disponíveis: ${targetSubitem.column_values.map(c => c.column.title).join(', ')}`);
      }
      
      return {
        subitem: targetSubitem,
        concluidoColumn: concluidoColumn
      };
    } else {
      console.log(`❌ Subitem "${subitemName}" não encontrado após normalização`);
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

// Processar webhook do Monday para PROJETOS
async function processProjetosWebhook(body) {
  console.log('📦 Webhook PROJETOS recebido - Iniciando processamento...');
  
  try {
    const event = body.event;
    const itemId = event.pulseId;
    
    if (!itemId) {
      console.log('❌ Item ID não encontrado no evento');
      return;
    }
    
    console.log(`🔍 Processando item: ${itemId}`);
    
    // 1. Verificar os arquivos na coluna PROJETOS
    const projetosInfo = await checkProjetos(itemId);
    
    if (!projetosInfo || !projetosInfo.hasProjetosColumn) {
      console.log('❌ Informações de projetos não disponíveis');
      return;
    }
    
    console.log(`📊 RESUMO PROJETOS:`);
    console.log(`   Item: ${projetosInfo.itemName}`);
    console.log(`   Total de arquivos: ${projetosInfo.totalFiles}`);
    console.log(`   Tem ARQ*.pdf: ${projetosInfo.hasArqPdf}`);
    console.log(`   Tem HIDRO*.pdf: ${projetosInfo.hasHidroPdf}`);
    console.log(`   Tem MEMORIAIS*.pdf: ${projetosInfo.hasMemoriaisPdf}`);
    
    if (projetosInfo.totalFiles > 0) {
      console.log(`   Arquivos: ${projetosInfo.fileNames.join(', ')}`);
    }
    
    // 2. Verificar condições: 3 arquivos específicos
    if (projetosInfo.allConditionsMet) {
      console.log('🎯 CONDIÇÃO ATENDIDA: 3 documentos específicos encontrados (ARQ, HIDRO, MEMORIAIS)');
      
      // 3. Procurar o subitem "EXE. PROJETO" (com busca flexível)
      const subitemInfo = await findSubitemByName(itemId, 'EXE. PROJETO');
      
      if (subitemInfo && subitemInfo.subitem && subitemInfo.concluidoColumn) {
        console.log('✅ Subitem e coluna CONCLUIDO encontrados');
        
        // 4. Marcar a coluna CONCLUIDO como verdadeira
        await markConcluido(
          subitemInfo.subitem.id,
          subitemInfo.subitem.board.id,
          subitemInfo.concluidoColumn.column.id
        );
        
        console.log('🎉 PROCESSO CONCLUÍDO: Subitem EXE. PROJETO marcado como CONCLUIDO!');
        
      } else {
        console.log('❌ Subitem EXE. PROJETO ou coluna CONCLUIDO não encontrados');
        if (subitemInfo && subitemInfo.subitem && !subitemInfo.concluidoColumn) {
          console.log('⚠️  Subitem encontrado mas coluna CONCLUIDO não existe');
        }
      }
      
    } else {
      console.log('ℹ️  Condição não atendida:');
      console.log(`   - Esperado: 3 arquivos | Encontrado: ${projetosInfo.totalFiles}`);
      console.log(`   - Esperado: ARQ*.pdf | Encontrado: ${projetosInfo.hasArqPdf}`);
      console.log(`   - Esperado: HIDRO*.pdf | Encontrado: ${projetosInfo.hasHidroPdf}`);
      console.log(`   - Esperado: MEMORIAIS*.pdf | Encontrado: ${projetosInfo.hasMemoriaisPdf}`);
    }
    
    console.log('✅ Processamento do webhook PROJETOS concluído!');
    
  } catch (error) {
    console.error('❌ Erro ao processar webhook PROJETOS:', error);
    console.error('Stack trace:', error.stack);
  }
}

// Processar webhook do Monday para DOCUMENTAÇÃO (ATUALIZADA)
async function processDocumentacaoWebhook(body) {
  console.log('📦 Webhook DOCUMENTAÇÃO recebido - Iniciando processamento...');
  
  try {
    const event = body.event;
    const itemId = event.pulseId;
    
    if (!itemId) {
      console.log('❌ Item ID não encontrado no evento');
      return;
    }
    
    console.log(`🔍 Processando item: ${itemId}`);
    
    // 1. Verificar os arquivos na coluna DOCUMENTAÇÃO
    const documentacaoInfo = await checkDocumentacao(itemId);
    
    if (!documentacaoInfo || !documentacaoInfo.hasDocumentacaoColumn) {
      console.log('❌ Informações de documentação não disponíveis');
      return;
    }
    
    console.log(`📊 RESUMO DOCUMENTAÇÃO:`);
    console.log(`   Item: ${documentacaoInfo.itemName}`);
    console.log(`   Total de arquivos: ${documentacaoInfo.totalFiles}`);
    console.log(`   Tem MATR*.pdf: ${documentacaoInfo.hasMatrPdf}`);
    console.log(`   Tem ALVAR*.pdf: ${documentacaoInfo.hasAlvarPdf}`);
    console.log(`   Tem HABITE*.pdf: ${documentacaoInfo.hasHabitePdf}`);
    
    if (documentacaoInfo.totalFiles > 0) {
      console.log(`   Arquivos: ${documentacaoInfo.fileNames.join(', ')}`);
    }
    
    // 2. Verificar condições e processar conforme o tipo de arquivo
    if (documentacaoInfo.conditionMet && documentacaoInfo.targetSubitemName) {
      console.log(`🎯 CONDIÇÃO ATENDIDA: Arquivo ${documentacaoInfo.conditionType}*.pdf encontrado`);
      console.log(`🎯 Subitem alvo: ${documentacaoInfo.targetSubitemName}`);
      
      // 3. Procurar o subitem correspondente (com busca flexível)
      const subitemInfo = await findSubitemByName(itemId, documentacaoInfo.targetSubitemName);
      
      if (subitemInfo && subitemInfo.subitem && subitemInfo.concluidoColumn) {
        console.log('✅ Subitem e coluna CONCLUIDO encontrados');
        
        // 4. Marcar a coluna CONCLUIDO como verdadeira
        await markConcluido(
          subitemInfo.subitem.id,
          subitemInfo.subitem.board.id,
          subitemInfo.concluidoColumn.column.id
        );
        
        console.log(`🎉 PROCESSO CONCLUÍDO: Subitem ${documentacaoInfo.targetSubitemName} marcado como CONCLUIDO!`);
        
      } else {
        console.log(`❌ Subitem ${documentacaoInfo.targetSubitemName} ou coluna CONCLUIDO não encontrados`);
        if (subitemInfo && subitemInfo.subitem && !subitemInfo.concluidoColumn) {
          console.log('⚠️  Subitem encontrado mas coluna CONCLUIDO não existe');
        }
      }
      
    } else {
      console.log('ℹ️  Nenhuma condição atendida:');
      console.log(`   - Esperado: MATR*.pdf | Encontrado: ${documentacaoInfo.hasMatrPdf}`);
      console.log(`   - Esperado: ALVAR*.pdf | Encontrado: ${documentacaoInfo.hasAlvarPdf}`);
      console.log(`   - Esperado: HABITE*.pdf | Encontrado: ${documentacaoInfo.hasHabitePdf}`);
    }
    
    console.log('✅ Processamento do webhook DOCUMENTAÇÃO concluído!');
    
  } catch (error) {
    console.error('❌ Erro ao processar webhook DOCUMENTAÇÃO:', error);
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
  
  // Processar o webhook em segundo plano baseado na coluna
  if (body.event && body.event.columnTitle === 'PROJETOS') {
    console.log('🔄 Iniciando processamento PROJETOS em background...');
    processProjetosWebhook(body).catch(error => {
      console.error('💥 Erro não tratado no processamento do webhook:', error);
    });
  } else if (body.event && body.event.columnTitle === 'DOCUMENTAÇÃO') {
    console.log('🔄 Iniciando processamento DOCUMENTAÇÃO em background...');
    processDocumentacaoWebhook(body).catch(error => {
      console.error('💥 Erro não tratado no processamento do webhook:', error);
    });
  } else {
    console.log('ℹ️  Webhook não é das colunas PROJETOS ou DOCUMENTAÇÃO, ignorando...');
  }
});

// Rota para teste manual PROJETOS
app.post('/test-projetos', async (req, res) => {
  try {
    console.log('📍 POST /test-projetos recebido');
    const { itemId } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: 'itemId é obrigatório' });
    }
    
    // Simular o processamento completo
    const result = {
      itemId: itemId,
      steps: []
    };
    
    // 1. Verificar projetos
    const projetosInfo = await checkProjetos(itemId);
    result.projetosInfo = projetosInfo;
    result.steps.push('Verificação de projetos concluída');
    
    if (projetosInfo && projetosInfo.hasProjetosColumn) {
      // 2. Verificar condições
      const conditionMet = projetosInfo.allConditionsMet;
      result.conditionMet = conditionMet;
      result.steps.push(`Condição atendida: ${conditionMet}`);
      
      if (conditionMet) {
        // 3. Buscar subitem
        const subitemInfo = await findSubitemByName(itemId, 'EXE. PROJETO');
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
    console.error('❌ Erro em /test-projetos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rota para teste manual DOCUMENTAÇÃO
app.post('/test-documentacao', async (req, res) => {
  try {
    console.log('📍 POST /test-documentacao recebido');
    const { itemId } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: 'itemId é obrigatório' });
    }
    
    // Simular o processamento completo
    const result = {
      itemId: itemId,
      steps: []
    };
    
    // 1. Verificar documentação
    const documentacaoInfo = await checkDocumentacao(itemId);
    result.documentacaoInfo = documentacaoInfo;
    result.steps.push('Verificação de documentação concluída');
    
    if (documentacaoInfo && documentacaoInfo.hasDocumentacaoColumn) {
      // 2. Verificar condições
      const conditionMet = documentacaoInfo.conditionMet;
      result.conditionMet = conditionMet;
      result.steps.push(`Condição atendida: ${conditionMet}`);
      
      if (conditionMet) {
        // 3. Buscar subitem
        const subitemInfo = await findSubitemByName(itemId, documentacaoInfo.targetSubitemName);
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
    console.error('❌ Erro em /test-documentacao:', error);
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