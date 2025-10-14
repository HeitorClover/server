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

// Coluna de data
const DATE_COL_TITLE = 'FINALIZAÇÃO';

// Status aceitos
const ACCEPT = [
// 01 - Vendas CB 
  'aprovados cb', 'visita', 'fechado cb', 'escolha de projeto', 'desistente', 

// 02 - Atendimento: 
  'abrir conta', 'documentos', 'caixaaqui', 'assinatura', 'conformidade', 'conta ativa', 
  'comercial', 'doc pendente', 'restrição', 'avaliação', 'desist/demora',

// 03 - Avaliação:
  'aprovado', 'aprovados cb', 'condicionado', 'reprovado', 'analise', 'engenharia', 'projetos',  

// 04 - Projetos:
  'abrir o. s.', 'exe. projeto',  'unificação', 'desmembramento',
  'pci/memoriais','cont. empreitada', 'projeto completo', 'engenharia',

  'ab matricula', 'cartório/prefeitura', 'fazer escritura', 'doc - unificação', 'doc - desmembramento', 'emitir alvará', 'enel',

  'scpo', 'cno',

// 05 - Engenharia:
  'solicitada', 'eng. sem clientes', 'siopi', 

// 06 - Siopi:
  'assinatura', 'enviar conformidade', 'conformidade', 'conforme',

  'atualizar matricula', 'matricula atualizada',

// 07 - Assinatura de Contrato:
  'solicitar minuta', 'editar minuta', 'minuta editada', 'contrado assinado', 'registro em cartório',
  'garantia', 'garantia conforme', 'habite-se', 'averbação cartório',

// Outros:
  'concluido', 'reanálise', 'cadastro', 'processos parados', 'assinatura de contrato', 'medições', 
];

// Status que NÃO devem marcar a coluna CONCLUIDO
const EXCLUDE_FROM_COMPLETED = [''];

// Subitens que NÃO devem receber data e check
const EXCLUDED_SUBITEM_NAMES = [
  'DOC - AB MATRICULA',
  'DOC - FAZER ESCRITURA', 
  'DOC - UNIFICAÇÃO',
  'DOC - CARTÓRIO/PREFEITURA',
  'DOC - DESMEMBRAMENTO',
  'DOC - EMITIR ALVARÁ',
  'DOC - ALVARÁ EMITIDO',
  'DOC - ATUALIZAR MATRICULA',
  'ENG - SCPO',
  'ENG - CNO', 
  'EXE. PROJETO', 
  'DESMEMBRAMENTO',
  'UNIFICAÇÃO',
  'CONTRATO DE EMPREITADA',
  'CONTRATO DE COMPRA E VENDA'
];

// Status que só atribuem usuário (não colocam data/check)
const STATUS_ONLY_ASSIGN = [
  'ab matricula',
  'fazer escritura',
  'doc - unificação',
  'atualizar matricula',
  'doc - desmembramento',
  'emitir alvará',
  'cartório/prefeitura',
  'cno',
  'scpo'
];

console.log('--------------------------------------------');
console.log(`STARTUP: ${new Date().toISOString()}`);
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

// Pega subitens
async function getSubitemsOfItem(itemId) {
  const q = `query { items(ids: ${itemId}) { id subitems { id name } } }`;
  console.log(`> Query subitems do item ${itemId}`);
  const data = await gql(q);
  return data.items?.[0]?.subitems || [];
}

// Busca colunas do subitem
async function getSubitemBoardAndColumns(subitemId) {
  const q = `query {
    items(ids: ${subitemId}) {
      id
      board {
        id
        name
        columns { id title type settings_str }
      }
    }
  }`;
  console.log(`> Query board+columns do subitem ${subitemId}`);
  const data = await gql(q);
  const item = data.items?.[0];
  if (!item || !item.board) throw new Error(`Não achei board para subitem ${subitemId}`);
  return { boardId: item.board.id, cols: item.board.columns || [] };
}

// Busca colunas do item pai
async function getItemBoardAndColumns(itemId) {
  const q = `query {
    items(ids: ${itemId}) {
      id
      board {
        id
        name
        columns { id title type settings_str }
      }
    }
  }`;
  console.log(`> Query board+columns do item pai ${itemId}`);
  const data = await gql(q);
  const item = data.items?.[0];
  if (!item || !item.board) throw new Error(`Não achei board para item pai ${itemId}`);
  return { boardId: item.board.id, cols: item.board.columns || [] };
}

// Encontra coluna
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

// Seta data + hora atual na coluna de FINALIZAÇÃO
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

// Marca coluna CONCLUIDO como checked
async function setCompletedChecked(subitemId, boardId, columnId) {
  try {
    const mutation = `mutation {
      change_column_value(
        board_id: ${boardId},
        item_id: ${subitemId},
        column_id: "${columnId}",
        value: "{\\"checked\\":true}"
      ) { id }
    }`;

    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      body: JSON.stringify({ query: mutation })
    });
    const json = await res.json();
    console.log(`> setCompletedChecked result for ${subitemId}:`, JSON.stringify(json, null, 2));
    return json;
  } catch (err) {
    console.error(`> Erro ao marcar CONCLUIDO para ${subitemId}:`, err && err.message ? err.message : err);
    throw err;
  }
}

// Nova automação: atribui usuário específico
async function assignUserToSubitem(subitemId, boardId, cols, userId) {
  try {
    const responsibleCol = findColumn(cols, 'RESPONSÁVEL', 'people') ||
                           findColumn(cols, 'Responsável', 'people') ||
                           findColumn(cols, 'responsável', 'people');
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

// Encontra subitem pelo nome
async function findSubitemByName(itemId, subitemName) {
  const subitems = await getSubitemsOfItem(itemId);
  return subitems.find(subitem => 
    subitem.name.toLowerCase().includes(subitemName.toLowerCase())
  );
}

// CORREÇÃO: Obtém o responsável de um subitem (query GraphQL corrigida)
async function getResponsibleFromSubitem(subitemId) {
  try {
    const q = `query {
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
    
    const data = await gql(q);
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

// Aplica ações padrão em um subitem (data + check)
async function applyStandardActions(subitemId, boardId, cols, statusText) {
  const dateCol = findColumn(cols, DATE_COL_TITLE, 'date');
  if (!dateCol) {
    console.warn(`> Coluna de data "${DATE_COL_TITLE}" não encontrada para subitem ${subitemId}`);
    return;
  }
  
  await setTodayDate(subitemId, boardId, dateCol.id);
  console.log(`> Data atualizada para o subitem ${subitemId}`);

  // Marcar CONCLUIDO como checked (exceto para status excluídos)
  if (!EXCLUDE_FROM_COMPLETED.map(s => s.toLowerCase()).includes(statusText.toLowerCase())) {
    const completedCol = findColumn(cols, 'CONCLUIDO', 'checkbox');
    if (completedCol) {
      await setCompletedChecked(subitemId, boardId, completedCol.id);
      console.log(`> Coluna CONCLUIDO marcada como checked para subitem ${subitemId}`);
    } else {
      console.warn(`> Coluna "CONCLUIDO" não encontrada no subitem ${subitemId}`);
    }
  } else {
    console.log(`> Status "${statusText}" excluído da marcação CONCLUIDO`);
  }
}

// Verifica se o subitem está na lista de exclusão
function isSubitemExcluded(subitemName) {
  return EXCLUDED_SUBITEM_NAMES.some(name => 
    subitemName.toLowerCase().includes(name.toLowerCase())
  );
}

// NOVA FUNÇÃO: Muda o status do item pai
async function changeParentItemStatus(itemId, newStatus) {
  try {
    // Primeiro obtém o board e colunas do item pai
    const { boardId, cols } = await getItemBoardAndColumns(Number(itemId));
    
    // Encontra a coluna de status (assumindo que se chama "Status" ou similar)
    const statusCol = findColumn(cols, 'Status', 'status') || 
                     findColumn(cols, 'status', 'status') ||
                     findColumn(cols, 'Estado', 'status');
    
    if (!statusCol) {
      console.warn(`> Coluna de Status não encontrada para o item pai ${itemId}`);
      return false;
    }

    // Muda o status para ENGENHARIA
    const mutation = `mutation {
        change_column_value(
            board_id: ${boardId},
            item_id: ${itemId},
            column_id: "${statusCol.id}",
            value: "{\\"label\\":\\"${newStatus}\\"}"
        ) { id }
    }`;

    const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
        body: JSON.stringify({ query: mutation })
    });
    
    const json = await res.json();
    console.log(`> Status do item pai ${itemId} alterado para "${newStatus}":`, JSON.stringify(json, null, 2));
    return true;
    
  } catch (err) {
    console.error(`> Erro ao alterar status do item pai ${itemId}:`, err);
    return false;
  }
}

// Processa webhook
async function processEvent(body) {
  const ev = body.event || {};
  let statusText = '';
  try {
    statusText = ev.value?.label?.text || ev.value?.label || ev.columnTitle || ev.column_title || ev.payload?.value?.label || '';
  } catch (e) { statusText = ''; }
  statusText = String(statusText || '').trim();
  if (!statusText) return;

  if (!ACCEPT.map(s => s.toLowerCase()).includes(statusText.toLowerCase())) return;

  const candidates = [
    ev.pulseId, ev.pulse_id, ev.itemId, ev.item_id,
    body.pulseId, body.pulse_id, body.itemId, body.item_id,
    body.event?.itemId, body.event?.item_id, ev.payload?.itemId, ev.payload?.item_id
  ];
  const itemId = candidates.find(v => v && /^\d+$/.test(String(v)));
  if (!itemId) return;

  const subitems = await getSubitemsOfItem(Number(itemId));
  if (!subitems || subitems.length === 0) return;

  // Atualiza somente o último subitem
  const lastSubitem = subitems[subitems.length - 1];
  console.log(`> Nome do último subitem: "${lastSubitem.name}"`);

  try {
    const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitem.id);

    // REGRA 2: Quando mudar para "PROJ INICIADO" procurar o subitem "CRIAR PROJETO"
    if (statusText.toLowerCase().includes('proj iniciado')) {
      console.log(`> Status "PROJ INICIADO" detectado. Procurando subitem "CRIAR PROJETO"...`);
      
      const criarProjetoSubitem = await findSubitemByName(Number(itemId), 'criar projeto');
      if (criarProjetoSubitem) {
        console.log(`> Subitem "CRIAR PROJETO" encontrado (ID: ${criarProjetoSubitem.id}). Aplicando ações...`);
        const { boardId: criarProjetoBoardId, cols: criarProjetoCols } = await getSubitemBoardAndColumns(criarProjetoSubitem.id);
        
        // Aplicar ações padrão no subitem "CRIAR PROJETO" (mesmo se for DOC)
        await applyStandardActions(criarProjetoSubitem.id, criarProjetoBoardId, criarProjetoCols, statusText);
      } else {
        console.warn(`> Subitem "CRIAR PROJETO" não encontrado para o item ${itemId}`);
      }
    }

    // VERIFICAÇÃO: Não aplicar data/check se o subitem estiver na lista de exclusão OU se o status for apenas de atribuição
    const isStatusOnlyAssign = STATUS_ONLY_ASSIGN.some(status => 
      statusText.toLowerCase().includes(status.toLowerCase())
    );

    if (!isSubitemExcluded(lastSubitem.name) && !isStatusOnlyAssign) {
      // Ações padrão para o último subitem (data + check)
      await applyStandardActions(lastSubitem.id, boardId, cols, statusText);
    } else {
      console.log(`> Subitem "${lastSubitem.name}" está na lista de exclusão ou o status é apenas de atribuição. Pulando data e check.`);
    }

    // Colocar Maryanna ao abrir o.s.
    if (statusText.toLowerCase().includes('abrir o. s.')) {
      console.log(`> Atribuição do usuário 69279799 agendada para daqui a 5 segundos`);
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        
        const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardId, cols, 69279799);
        console.log(`> Usuário 69279799 atribuído ao subitem ${lastSubitemAfterDelay.id} (abrir o. s.)`);
      })();
    }

    //Colocar Deboráh 
    if (statusText.toLowerCase().includes('ab matricula')) {
      console.log(`> Atribuição do usuário 90917412 agendada para daqui a 5 segundos`);
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        
        const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardId, cols, 90917412);
        console.log(`> Usuário 90917412 atribuído ao subitem ${lastSubitemAfterDelay.id} (ab matricula)`);
      })();
    }  

    //Colocar Brenda 
    if (statusText.toLowerCase().includes('engenharia')) {
      console.log(`> Atribuição do usuário 69279574 agendada para daqui a 5 segundos`);
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        
        const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardId, cols, 69279574);
        console.log(`> Usuário 69279574 atribuído ao subitem ${lastSubitemAfterDelay.id} (engenharia)`);
      })();
    }

    //Colocar Yasnnan
    if (statusText.toLowerCase().includes('siopi') ||
        statusText.toLowerCase().includes('enviar conformidade')) {
      console.log(`> Atribuição do usuário 69227324 agendada para daqui a 5 segundos`);
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        
        const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardId, cols, 69227324);
        console.log(`> Usuário 69227324 atribuído ao subitem ${lastSubitemAfterDelay.id} (siopi)`);
      })();
    }

    //Colocar Hilgle Ferreira
    if (statusText.toLowerCase().includes('solicitar minuta')) {
      console.log(`> Atribuição do usuário 70239350 agendada para daqui a 5 segundos`);
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        
        const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardId, cols, 70239350);
        console.log(`> Usuário 70239350 atribuído ao subitem ${lastSubitemAfterDelay.id} (solicitar minuta)`);
      })();
    }

    // Colonar Bruna na Engenharia
    if (statusText.toLowerCase().includes('scpo') ||
        statusText.toLowerCase().includes('cno')) {
      
      console.log(`> Atribuição do usuário 69279560 agendada para daqui a 5 segundos`);
      
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        
        let targetSubitem;
        if (statusText.toLowerCase().includes('scpo')) {
          // Para "scpo" usa o ANTEPENÚLTIMO subitem
          if (subitemsAfterDelay.length >= 3) {
            targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 3];
            console.log(`> Status "scpo" detectado. Atribuindo ao ANTEPENÚLTIMO subitem: "${targetSubitem.name}"`);
          } else if (subitemsAfterDelay.length === 2) {
            targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 2];
            console.log(`> Status "scpo" detectado, mas há apenas 2 subitems. Atribuindo ao penúltimo: "${targetSubitem.name}"`);
          } else {
            targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 1];
            console.log(`> Status "scpo" detectado, mas há apenas um subitem. Atribuindo ao último: "${targetSubitem.name}"`);
          }
        } else {
          // Para "cno" usa o ÚLTIMO subitem
          targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 1];
          console.log(`> Status "cno" detectado. Atribuindo ao ÚLTIMO subitem: "${targetSubitem.name}"`);
        }
        
        const { boardId, cols } = await getSubitemBoardAndColumns(targetSubitem.id);
        await assignUserToSubitem(targetSubitem.id, boardId, cols, 69279560);
        console.log(`> Usuário 69279560 atribuído ao subitem ${targetSubitem.id} (${statusText.toLowerCase().includes('scpo') ? 'scpo' : 'cno'})`);

        // NOVA REGRA: Verificação específica para ENG - CNO
        if (statusText.toLowerCase().includes('cno') || statusText.toLowerCase().includes('cno')) {
          console.log(`> Verificando existência do subitem "CONTRATO DE EMPREITADA" para ENG - CNO...`);
          
          const contratoEmpreitadaSubitem = await findSubitemByName(Number(itemId), 'CONTRATO DE EMPREITADA');
          if (contratoEmpreitadaSubitem) {
            console.log(`> Subitem "CONTRATO DE EMPREITADA" encontrado! Alterando status do item pai para ENGENHARIA...`);
            await changeParentItemStatus(Number(itemId), 'ENGENHARIA');
          } else {
            console.log(`> Subitem "CONTRATO DE EMPREITADA" não encontrado.`);
          }
        }
      })();
    }

    // Colocar Henrique nos Documentos
    else if (statusText.toLowerCase().includes('ab matricula') ||
          statusText.toLowerCase().includes('fazer escritura') ||
          statusText.toLowerCase().includes('doc - unificação') ||
          statusText.toLowerCase().includes('doc - desmembramento') ||
          statusText.toLowerCase().includes('atualizar matricula') ||
          statusText.toLowerCase().includes('cartório/prefeitura') ||
          statusText.toLowerCase().includes('habite-se') ||
          statusText.toLowerCase().includes('enel') ||
          statusText.toLowerCase().includes('averbação cartório') ||
          statusText.toLowerCase().includes('emitir alvará')) {
      
      console.log(`> Status "${statusText}" detectado. Atribuição do usuário 69279625 agendada para daqui a 5 segundos`);
      
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        // Revalida qual é o último subitem após 5 segundos
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        
        let targetSubitem;
        if (statusText.toLowerCase().includes('ab matricula') || statusText.toLowerCase().includes('enel')) {
          // Para "ab matricula" e "enel" usa o PENÚLTIMO subitem
          if (subitemsAfterDelay.length >= 2) {
            targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 2];
            console.log(`> Status "${statusText}" detectado. Atribuindo ao PENÚLTIMO subitem: "${targetSubitem.name}"`);
          } else {
            targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 1];
            console.log(`> Status "${statusText}" detectado, mas há apenas um subitem. Atribuindo ao último: "${targetSubitem.name}"`);
          }
        } else {
          // Para outros status usa o ÚLTIMO subitem
          targetSubitem = subitemsAfterDelay[subitemsAfterDelay.length - 1];
          console.log(`> Atribuindo ao ÚLTIMO subitem: "${targetSubitem.name}"`);
        }
        
        const { boardId: boardIdAfterDelay, cols: colsAfterDelay } = await getSubitemBoardAndColumns(targetSubitem.id);
        await assignUserToSubitem(targetSubitem.id, boardIdAfterDelay, colsAfterDelay, 69279625);
        console.log(`> Usuário 69279625 atribuído ao subitem ${targetSubitem.id} (${statusText})`);
      })();
    }

    // NOVA FUNCIONALIDADE MODIFICADA: Para unificação, criar projeto e desmembramento - copiar responsável de "ESCOLHA DE PROJETO"
    // COM ADIÇÃO DA VERIFICAÇÃO ESPECÍFICA PARA "CONT. EMPREITADA"
    else if (statusText.toLowerCase().includes('exe. projeto') ||
            statusText.toLowerCase().includes('unificação') ||
            statusText.toLowerCase().includes('cont. empreitada') ||
            statusText.toLowerCase().includes('pci/memoriais') ||
            statusText.toLowerCase().includes('desmembramento')) {
      
      console.log(`> Status "${statusText}" detectado. Aguardando 5 segundos antes de copiar responsável...`);
      
      (async () => {
        await new Promise(res => setTimeout(res, 5 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 5 segundos`);
          return;
        }
        
        // DETERMINA QUAL SUBITEM RECEBERÁ O RESPONSÁVEL
        let targetSubitemForResponsible;
        if (statusText.toLowerCase().includes('pci/memoriais')) {
          // Para "pci/memoriais" usa o PENÚLTIMO subitem
          if (subitemsAfterDelay.length >= 2) {
            targetSubitemForResponsible = subitemsAfterDelay[subitemsAfterDelay.length - 2];
            console.log(`> Status "pci/memoriais" detectado. Atribuindo responsável ao PENÚLTIMO subitem: "${targetSubitemForResponsible.name}"`);
          } else {
            targetSubitemForResponsible = subitemsAfterDelay[subitemsAfterDelay.length - 1];
            console.log(`> Status "pci/memoriais" detectado, mas há apenas um subitem. Atribuindo responsável ao último: "${targetSubitemForResponsible.name}"`);
          }
        } else {
          // Para outros status usa o ÚLTIMO subitem
          targetSubitemForResponsible = subitemsAfterDelay[subitemsAfterDelay.length - 1];
          console.log(`> Atribuindo responsável ao ÚLTIMO subitem: "${targetSubitemForResponsible.name}"`);
        }
        
        const { boardId: boardIdAfterDelay, cols: colsAfterDelay } = await getSubitemBoardAndColumns(targetSubitemForResponsible.id);
        
        // VERIFICAÇÃO ESPECÍFICA PARA "CONT. EMPREITADA"
        if (statusText.toLowerCase().includes('cont. empreitada')) {
            console.log(`> Verificando subitems específicos para "cont. empreitada"...`);
            
            const targetSubitemNames = ['ENG - SCPO', 'ENG - CNO', 'DOC - ENEL'];
            const hasTargetSubitem = subitemsAfterDelay.some(subitem => 
                targetSubitemNames.some(name => 
                    subitem.name.toLowerCase().includes(name.toLowerCase())
                )
            );
            
            if (hasTargetSubitem) {
                console.log(`> Subitem específico encontrado! Alterando status do item pai para ENGENHARIA...`);
                await changeParentItemStatus(Number(itemId), 'ENGENHARIA');
            } else {
                console.log(`> Nenhum subitem específico (ENG - SCPO, ENG - CNO, DOC - ENEL) encontrado.`);
            }
        }
        
        // Procura o subitem "ESCOLHA DE PROJETO" após o delay
        console.log(`> Procurando responsável do subitem "ESCOLHA DE PROJETO"...`);
        
        const escolhaProjetoSubitem = await findSubitemByName(Number(itemId), 'ESCOLHA DE PROJETO');
        if (escolhaProjetoSubitem) {
          console.log(`> Subitem "ESCOLHA DE PROJETO" encontrado (ID: ${escolhaProjetoSubitem.id}). Obtendo responsável...`);
          
          const responsibleUserId = await getResponsibleFromSubitem(escolhaProjetoSubitem.id);
          if (responsibleUserId) {
            console.log(`> Responsável encontrado: ${responsibleUserId}. Atribuindo ao subitem...`);
            await assignUserToSubitem(targetSubitemForResponsible.id, boardIdAfterDelay, colsAfterDelay, responsibleUserId);
            console.log(`> Responsável copiado de "ESCOLHA DE PROJETO" para o subitem ${targetSubitemForResponsible.id}`);
          } else {
            console.warn(`> Nenhum responsável encontrado no subitem "ESCOLHA DE PROJETO"`);
          }
        } else {
          console.warn(`> Subitem "ESCOLHA DE PROJETO" não encontrado para o item ${itemId}`);
        }
      })();
    }

  } catch (err) {
    console.error(`> Erro ao processar subitem ${lastSubitem.id}:`, err && err.message ? err.message : err);
  }
}

// Rota webhook
app.post('/webhook', (req, res) => {
  const body = req.body || {};
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });
  res.status(200).json({ ok: true, boot: BOOT_ID });
  processEvent(body).catch(err => console.error('processEvent erro:', err));
});

app.get('/', (_req, res) => res.send(`Servidor rodando — BOOT_ID: ${BOOT_ID}`));
app.get('/webhook', (_req, res) => res.json({ status: 'ok', now: new Date().toISOString(), boot_id: BOOT_ID }));

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 Server rodando na porta ${PORT} — BOOT_ID: ${BOOT_ID}`));