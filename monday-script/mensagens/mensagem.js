// mensagem.js
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// Configurações fixas
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;       
const EVOLUTION_URL = "https://api.faleai.chat";         
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY; 
const SESSION_ID = "manager";                            
const DESTINO = "5588998685336";                         
const TARGET_PERSON_ID = "69279625";                    

// Logs de debug das variáveis de ambiente
console.log("🔹 Verificando variáveis de ambiente...");
console.log("MONDAY_API_KEY:", MONDAY_API_KEY ? "OK" : "❌ Faltando");
console.log("EVOLUTION_API_KEY:", EVOLUTION_API_KEY ? "OK" : "❌ Faltando");

if (!MONDAY_API_KEY || !EVOLUTION_API_KEY) {
  console.error("❌ Configure MONDAY_API_KEY e EVOLUTION_API_KEY no Render antes de subir o servidor.");
  process.exit(1);
}

// Função para enviar mensagem
async function sendWhatsappMessage(text) {
  try {
    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${SESSION_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ to: DESTINO, text }),
    });
    const json = await res.json();
    console.log("✅ Mensagem enviada:", JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("❌ Erro ao enviar WhatsApp:", err.message || err);
  }
}

// Processa evento do Monday
async function processEvent(body) {
  try {
    const ev = body.event || {};
    const novoResponsavelId = ev.value?.personsAndTeams?.[0]?.id || ev.value?.changed_person_id || null;

    console.log("📌 Evento recebido - novoResponsavelId:", novoResponsavelId);

    if (String(novoResponsavelId) === TARGET_PERSON_ID) {
      await sendWhatsappMessage("⚡ O responsável agora é Henrique!");
      console.log("📌 Trigger acionado para ID:", TARGET_PERSON_ID);
    }
  } catch (err) {
    console.error("❌ Erro processando evento:", err.message || err);
  }
}

// Rota webhook
app.post("/webhook", (req, res) => {
  const body = req.body || {};
  if (body.challenge) return res.status(200).json({ challenge: body.challenge });
  res.status(200).json({ ok: true });
  processEvent(body).catch(err => console.error("Erro processEvent:", err));
});

// Rota teste
app.get("/", (_req, res) => res.send("Servidor rodando — Automação WhatsApp Evolution + Monday"));

// Start server
const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`🚀 mensagem.js rodando na porta ${PORT}`));
