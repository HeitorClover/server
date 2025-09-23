const fetch = require('node-fetch');

const API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjU1NDIxMzcyNSwiYWFpIjoxMSwidWlkIjo2OTIyNzMyNywiaWFkIjoiMjAyNS0wOC0yNVQxODowMToxNS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQyODE1NTksInJnbiI6InVzZTEifQ.W0gS5NCcBO5iVEljH3FjccT9vO8evxS2f75Beh6gYdQ';     
const BOARD_ID = 9852597957;
const SUBITEM_STATUS_COLUMN = 'Controle';  // Nome ou ID da coluna de status do subitem

async function getStatusIndex() {
  const query = `
    query {
      boards(ids: ${BOARD_ID}) {
        columns {
          id
          title
          settings_str
        }
      }
    }
  `;

  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Authorization': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });

  const data = await res.json();

  // Procura a coluna de status dos subitems
  const statusColumn = data.data.boards[0].columns.find(c => c.id === SUBITEM_STATUS_COLUMN || c.title.toLowerCase() === SUBITEM_STATUS_COLUMN.toLowerCase());

  if (!statusColumn) {
    console.log("Coluna de status não encontrada!");
    return;
  }

  console.log("Coluna de status encontrada:");
  console.log(statusColumn);

  // Mostra os labels e índices
  const settings = JSON.parse(statusColumn.settings_str);
  console.log("Labels e índices:");
  console.log(settings.labels);
}

getStatusIndex();
