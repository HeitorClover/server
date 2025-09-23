const fetch = require('node-fetch');

const API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjU1NDIxMzcyNSwiYWFpIjoxMSwidWlkIjo2OTIyNzMyNywiaWFkIjoiMjAyNS0wOC0yNVQxODowMToxNS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjQyODE1NTksInJnbiI6InVzZTEifQ.W0gS5NCcBO5iVEljH3FjccT9vO8evxS2f75Beh6gYdQ';     
const BOARD_ID = 9852597957;                // ID do seu board

async function getGroups() {
  const query = `
    query {
      boards(ids: ${BOARD_ID}) {
        groups {
          id
          title
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
  console.log("Grupos do board:", data.data.boards[0].groups);
}

getGroups();
