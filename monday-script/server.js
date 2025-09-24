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
  'abrir conta','comercial','documentos','caixaaqui','doc pendente','assinatura','restrição',
  'conformidade','avaliação','conta ativa','desist/demora','aprovado','condicionado','reprovado', 'analise',
  'ab matricula', 'fazer escritura', 'emitir alvará', 'alvara emitido', 'abrir o. s.', 'criar projeto', 'unificação' , 'desmembramento', 'proj iniciado', 'pci/memorial' , 'engenharia',
  'concluido','siopi','solicitada', 'assinatura', 'desmembramento inciado', 'unificação iniciada', 'doc - unificação' , 'doc - desmembramento'
  , 'enviar conformidade', 'conformidade' , 'conforme', 'solicitar minuta' , 'contrato marcado' , 'minuta editada' , 
  'contrado assinado' , 'garantia' , 'garantia conforme' , 'reanálise' , 'cadastro' , 'processos parados' , 'assinatura de contrato' ,
  'medições' , 'aprovados cb'
];

// Status que NÃO devem marcar a coluna CONCLUIDO
const EXCLUDE_FROM_COMPLETED = ['pci/memorial', 'unificação', 'desmembramento'];

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

  // REMOVIDO: Regras de exclusão para "CRIAR PROJETO" e "PROJ INICIADO"
  // Agora todos os subitens serão processados normalmente

  try {
    const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitem.id);

    // REGRA 2: Quando mudar para "PROJ INICIADO" procurar o subitem "CRIAR PROJETO"
    if (statusText.toLowerCase().includes('proj iniciado')) {
      console.log(`> Status "PROJ INICIADO" detectado. Procurando subitem "CRIAR PROJETO"...`);
      
      const criarProjetoSubitem = await findSubitemByName(Number(itemId), 'criar projeto');
      if (criarProjetoSubitem) {
        console.log(`> Subitem "CRIAR PROJETO" encontrado (ID: ${criarProjetoSubitem.id}). Aplicando ações...`);
        const { boardId: criarProjetoBoardId, cols: criarProjetoCols } = await getSubitemBoardAndColumns(criarProjetoSubitem.id);
        
        // Aplicar ações padrão no subitem "CRIAR PROJETO"
        await applyStandardActions(criarProjetoSubitem.id, criarProjetoBoardId, criarProjetoCols, statusText);
      } else {
        console.warn(`> Subitem "CRIAR PROJETO" não encontrado para o item ${itemId}`);
      }
    }

    // Ações padrão para o último subitem (data + check)
    await applyStandardActions(lastSubitem.id, boardId, cols, statusText);

    // NOVA LÓGICA: Atribuição de usuários específica por status
    if (statusText.toLowerCase().includes('abrir o. s.')) {
      console.log(`> Atribuição do usuário 69279799 agendada para daqui a 20 segundos`);
      (async () => {
        await new Promise(res => setTimeout(res, 20 * 1000));
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 20 segundos`);
          return;
        }
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        
        const { boardId, cols } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardId, cols, 69279799);
        console.log(`> Usuário 69279799 atribuído ao subitem ${lastSubitemAfterDelay.id} (abrir o. s.)`);
      })();
    }

    // NOVA FUNCIONALIDADE: Para "ab matricula" e "emitir alvará" - atribuir usuário 69279625 após 20 segundos
    else if (statusText.toLowerCase().includes('ab matricula') ||
             statusText.toLowerCase().includes('fazer escritura') ||
             statusText.toLowerCase().includes('doc - unificação') ||
             statusText.toLowerCase().includes('doc - desmembramento') ||
             statusText.toLowerCase().includes('emitir alvará')) {
      
      console.log(`> Status "${statusText}" detectado. Atribuição do usuário 69279625 agendada para daqui a 20 segundos`);
      
      (async () => {
        await new Promise(res => setTimeout(res, 20 * 1000));
        
        // Revalida qual é o último subitem após 20 segundos
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 20 segundos`);
          return;
        }
        
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        console.log(`> Último subitem após 20 segundos: "${lastSubitemAfterDelay.name}"`);
        
        const { boardId: boardIdAfterDelay, cols: colsAfterDelay } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        await assignUserToSubitem(lastSubitemAfterDelay.id, boardIdAfterDelay, colsAfterDelay, 69279625);
        console.log(`> Usuário 69279625 atribuído ao subitem ${lastSubitemAfterDelay.id} (${statusText})`);
      })();
    }

    // NOVA FUNCIONALIDADE MODIFICADA: Para unificação, criar projeto e desmembramento - copiar responsável de "ESCOLHA DE PROJETO"
    else if (statusText.toLowerCase().includes('criar projeto') || 
             statusText.toLowerCase().includes('proj iniciado') ||
             statusText.toLowerCase().includes('unificação') ||
             statusText.toLowerCase().includes('unificação iniciada') ||
             statusText.toLowerCase().includes('desmembramento') ||
             statusText.toLowerCase().includes('desmembramento iniciado')) {
      
      console.log(`> Status "${statusText}" detectado. Aguardando 15 segundos antes de copiar responsável...`);
      
      (async () => {
        
        await new Promise(res => setTimeout(res, 15 * 1000));
        
        
        const subitemsAfterDelay = await getSubitemsOfItem(Number(itemId));
        if (!subitemsAfterDelay || subitemsAfterDelay.length === 0) {
          console.warn(`> Nenhum subitem encontrado após 15 segundos`);
          return;
        }
        
        const lastSubitemAfterDelay = subitemsAfterDelay[subitemsAfterDelay.length - 1];
        console.log(`> Último subitem após 15 segundos: "${lastSubitemAfterDelay.name}"`);
        
        // Obtém o board e colunas do último subitem atualizado
        const { boardId: boardIdAfterDelay, cols: colsAfterDelay } = await getSubitemBoardAndColumns(lastSubitemAfterDelay.id);
        
        // Procura o subitem "ESCOLHA DE PROJETO" após o delay
        console.log(`> Procurando responsável do subitem "ESCOLHA DE PROJETO"...`);
        
        const escolhaProjetoSubitem = await findSubitemByName(Number(itemId), 'ESCOLHA DE PROJETO');
        if (escolhaProjetoSubitem) {
          console.log(`> Subitem "ESCOLHA DE PROJETO" encontrado (ID: ${escolhaProjetoSubitem.id}). Obtendo responsável...`);
          
          const responsibleUserId = await getResponsibleFromSubitem(escolhaProjetoSubitem.id);
          if (responsibleUserId) {
            console.log(`> Responsável encontrado: ${responsibleUserId}. Atribuindo ao último subitem...`);
            await assignUserToSubitem(lastSubitemAfterDelay.id, boardIdAfterDelay, colsAfterDelay, responsibleUserId);
            console.log(`> Responsável copiado de "ESCOLHA DE PROJETO" para o subitem ${lastSubitemAfterDelay.id}`);
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