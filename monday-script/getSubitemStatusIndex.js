const fetch = require('node-fetch');

const API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjU1NDIxMzcyNSwiYWFpIjoxMSwidWlkIjo2OTIyNzMyNywiaWFkIjoiMjAyNS0wOC0yNVQxODowMToxNS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQyODE1NTksInJnbiI6InVzZTEifQ.W0gS5NCcBO5iVEljH3FjccT9vO8evxS2f75Beh6gYdQ'; 
const ITEM_ID = 9893888379;    // Item que já possui subitems
const SUBITEM_STATUS_COLUMN = 'Controle'; // Nome ou ID da coluna de status do subitem

async function getSubitemStatusIndex() {
  const query = `
    query {
      items(ids: ${ITEM_ID}) {
        subitems {
          id
          column_values {
            id
            title
            settings_str
          }
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
  console.log(JSON.stringify(data, null, 2));
}

getSubitemStatusIndex();