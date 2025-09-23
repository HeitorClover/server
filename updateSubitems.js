const fetch = require('node-fetch');

// --------- CONFIGURAÇÕES (substitua) ---------
const API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjU1NDIxMzcyNSwiYWFpIjoxMSwidWlkIjo2OTIyNzMyNywiaWFkIjoiMjAyNS0wOC0yNVQxODowMToxNS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQyODE1NTksInJnbiI6InVzZTEifQ.W0gS5NCcBO5iVEljH3FjccT9vO8evxS2f75Beh6gYdQ';                   // Cole aqui seu token da API (não exponha)
const BOARD_ID = 9852597957;                 // ID do board
const DONE_GROUP_ID = 'group_mktzwjwb';      // ID do grupo "Feito" (o seu)
const SUBITEM_STATUS_COLUMN = 'Controle';    // coluna de status dos subitems
const FECHADO_STATUS_INDEX = 3;              // índice do status "Fechado" (você disse que é 3)
// Ajustes de paginação
const PAGE_SIZE = 25;                        // quantos itens por página (diminua se necessário)
// ---------------------------------------------

async function fetchGraphQL(query) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Authorization': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  if (data.errors) {
    // devolve o erro para o chamador tratar
    throw data;
  }
  return data;
}

// pega itens (com subitems) só do grupo DONE_GROUP_ID, paginando
async function getAllItemsFromGroup(groupId) {
  let allItems = [];
  let page = 1;

  while (true) {
    const query = `
      query {
        boards(ids: ${BOARD_ID}) {
          groups(ids: "${groupId}") {
            id
            items_page(limit: ${PAGE_SIZE}, page: ${page}) {
              items {
                id
                name
                subitems {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;
    const data = await fetchGraphQL(query);
    const groups = data.data?.boards?.[0]?.groups;
    if (!groups || groups.length === 0) break;
    const items = groups[0].items_page.items;
    if (!items || items.length === 0) break;

    allItems = allItems.concat(items);
    if (items.length < PAGE_SIZE) break; // última página
    page++;
  }

  return allItems;
}

// atualiza coluna de status do subitem
async function updateSubitemStatus(subitemId) {
  const mutation = `
    mutation {
      change_column_value(
        board_id: ${BOARD_ID},
        item_id: ${subitemId},
        column_id: "${SUBITEM_STATUS_COLUMN}",
        value: "{\\"index\\":${FECHADO_STATUS_INDEX}}"
      ) {
        id
      }
    }
  `;
  try {
    const res = await fetchGraphQL(mutation);
    return res;
  } catch (err) {
    console.error(`Erro ao atualizar subitem ${subitemId}:`, JSON.stringify(err, null, 2));
    return null;
  }
}

// função helper para pequena espera (evita throttling)
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// principal
(async () => {
  try {
    console.log("Buscando itens no grupo...", DONE_GROUP_ID);
    const items = await getAllItemsFromGroup(DONE_GROUP_ID);
    if (!items || items.length === 0) {
      console.log("Nenhum item encontrado no grupo informado.");
      return;
    }
    console.log(`Foram encontrados ${items.length} itens no grupo.`);

    for (const item of items) {
      if (!item.subitems || item.subitems.length === 0) continue;
      for (const sub of item.subitems) {
        console.log(`Atualizando subitem "${sub.name}" (${sub.id}) -> índice ${FECHADO_STATUS_INDEX}`);
        await updateSubitemStatus(sub.id);
        await sleep(150); // pausa curta para diminuir chance de rate-limit
      }
    }

    console.log("✅ Feito: todos os subitems do grupo foram processados.");
  } catch (err) {
    // se a API retornar complexidade ou outro erro, mostramos aqui
    console.error("Erro geral:", JSON.stringify(err, null, 2));
    console.error("Se for 'maxComplexityExceeded', reduza PAGE_SIZE ou prefira acionar por webhook (recomendado).");
  }
})();
