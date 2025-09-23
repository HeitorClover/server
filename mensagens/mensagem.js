// mensagem.js
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" })); // Apenas express.json()

// Configurações
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_URL = "https://api.faleai.chat";
const SESSION_ID = "manager";
const DESTINO = "5588998685336";
const TARGET_PERSON_ID = "69279625";

// Logs das variáveis de ambiente
console.log("🔹 Verificando variáveis de ambiente...");
console.log("MONDAY_API_KEY:", MONDAY_API_KEY ? "OK" : "❌ Faltando");
console.log("EVOLUTION_API_KEY:", EVOLUTION_API_KEY ? "OK" : "❌ Faltando");
if (!MONDAY_API_KEY || !EVOLUTION_API_KEY) {
  console.error("❌ Configure MONDAY_API_KEY e EVOLUTION_API_KEY no Render antes de subir o servidor.");
  process.exit(1);
}

// Função para enviar mensagem via Evolution
async function sendWhatsappMessage(text) {
  try {
    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${SESSION_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: DESTINO, text }) // "number" obrigatório
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
    console.log("📌 Evento recebido completo:", JSON.stringify(ev, null, 2));

    const novoResponsavelId =
      ev.value?.personsAndTeams?.[0]?.id ||
      ev.value?.changed_person_id ||
      ev?.column_values?.find(cv => cv.id === "responsavel")?.value?.personsAndTeams?.[0]?.id ||
      null;

    console.log("📌 novoResponsavelId detectado:", novoResponsavelId);

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
  const body = req.body;

  // Responde imediatamente ao desafio do Monday
  if (body.challenge) {
    console.log("📌 Challenge recebido:", body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }

  // Responde ok e processa evento em background
  res.status(200).json({ ok: true });
  processEvent(body).catch(err => console.error("Erro processEvent:", err));
});

// Rota teste
app.get("/", (_req, res) => res.send("Servidor rodando — Automação WhatsApp Evolution + Monday"));

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 mensagem.js rodando na porta ${PORT}`));
