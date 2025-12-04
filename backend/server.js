// server.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { readDB, writeDB } = require("./utils-db");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const SALT_ROUNDS = 10;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ⬇ AQUI ADICIONADO (3 LINHAS)
const path = require("path");
app.use(express.static(path.join(__dirname, "frontend")));
// ⬆ AQUI ADICIONADO

// Middlewares
// ⬇⬇⬇ *** CORREÇÃO DO CORS (APENAS ISSO FOI ALTERADO) *** ⬇⬇⬇
app.use(cors());
// ⬆⬆⬆ *** CORREÇÃO AQUI *** ⬆⬆⬆

app.use(bodyParser.json());

app.use(rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
  max: parseInt(process.env.RATE_LIMIT_MAX || "60"),
  standardHeaders: true,
  legacyHeaders: false,
}));

// === Helpers ===
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "1d" });
}

function verifyTokenFromHeader(req) {
  const auth = req.headers["authorization"];
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length !== 2) return null;
  const token = parts[1];
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// === AUTH ROUTES ===

// Register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: "Preencha email e senha" });

    const db = readDB();
    if (db.usuarios.find(u => u.email === email)) return res.status(400).json({ erro: "Usuário já existe" });

    const hash = await bcrypt.hash(senha, SALT_ROUNDS);
    const id = Date.now();
    db.usuarios.push({ id, email, password: hash, created_at: new Date().toISOString() });
    writeDB(db);

    res.json({ sucesso: true });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: "Preencha email e senha" });

    const db = readDB();
    const user = db.usuarios.find(u => u.email === email);
    if (!user) return res.status(400).json({ erro: "Usuário não encontrado" });

    const ok = await bcrypt.compare(senha, user.password);
    if (!ok) return res.status(400).json({ erro: "Senha incorreta" });

    const token = generateToken({ id: user.id, email: user.email });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// Verify token
app.post("/auth/verify", (req, res) => {
  const token = req.body.token || req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.json({ valido: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ valido: true, user: payload });
  } catch (e) {
    res.json({ valido: false });
  }
});

// === CHAT ROUTES (usando db.json) ===

function requireAuth(req, res, next) {
  const payload = verifyTokenFromHeader(req);
  if (!payload) return res.status(401).json({ erro: "Não autorizado" });
  req.user = payload;
  next();
}

app.post("/chat/new", requireAuth, (req, res) => {
  const db = readDB();
  const id = Date.now();
  const title = req.body.title || "Novo chat";
  db.chats.push({ id, user_id: req.user.id, title, created_at: new Date().toISOString() });
  writeDB(db);
  res.json({ id, title });
});

app.get("/chat/list", requireAuth, (req, res) => {
  const db = readDB();
  const userChats = db.chats.filter(c => c.user_id === req.user.id).sort((a,b)=>b.created_at.localeCompare(a.created_at));
  res.json(userChats);
});

app.get("/chat/:id", requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  const db = readDB();
  const chat = db.chats.find(c => c.id === chatId && c.user_id === req.user.id);
  if (!chat) return res.status(404).json({ erro: "Chat não encontrado" });

  const mensagens = db.mensagens.filter(m => m.chat_id === chatId);
  res.json({ chat, mensagens });
});

app.delete("/chat/:id", requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  const db = readDB();
  db.chats = db.chats.filter(c => !(c.id === chatId && c.user_id === req.user.id));
  db.mensagens = db.mensagens.filter(m => m.chat_id !== chatId);
  writeDB(db);
  res.json({ sucesso: true });
});

app.post("/chat/send", requireAuth, async (req, res) => {
  try {
    const { chatId, mensagem } = req.body;
    if (!mensagem) return res.status(400).json({ erro: "Mensagem vazia" });

    const db = readDB();

    let chat = null;
    if (chatId) {
      chat = db.chats.find(c => c.id === Number(chatId) && c.user_id === req.user.id);
      if (!chat) return res.status(404).json({ erro: "Chat não encontrado" });
    } else {
      const id = Date.now();
      chat = { id, user_id: req.user.id, title: "Novo chat", created_at: new Date().toISOString() };
      db.chats.push(chat);
    }

    const userMsg = { id: Date.now() + 1, chat_id: chat.id, role: "user", content: mensagem, created_at: new Date().toISOString() };
    db.mensagens.push(userMsg);
    writeDB(db);

    const history = db.mensagens
      .filter(m => m.chat_id === chat.id)
      .slice(-30)
      .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    const messagesForModel = [
      { role: "system", content: "Você é a Lucky.ia — assistente útil, educada e objetiva." },
      ...history
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForModel,
      max_tokens: 800
    });

    const resposta = completion.choices?.[0]?.message?.content || "Desculpe, não consegui gerar resposta.";

    const assistantMsg = { id: Date.now() + 2, chat_id: chat.id, role: "assistant", content: resposta, created_at: new Date().toISOString() };
    db.mensagens.push(assistantMsg);
    writeDB(db);

    res.json({ resposta, chatId: chat.id });
  } catch (err) {
    console.error("Erro /chat/send:", err?.message || err);
    res.status(500).json({ erro: "Erro ao conversar com a IA" });
  }
});

// rota ping
app.get("/ping", (req, res) => res.json({ ok: true }));

app.listen(PORT, () =>
  console.log(`Lucky.ia backend (db.json) rodando na porta ${PORT}`)
);
