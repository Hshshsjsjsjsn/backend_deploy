// utils-db.js
const fs = require("fs");
const path = require("path");
const dbPath = path.join(__dirname, "db.json");

function readDB() {
  try {
    const raw = fs.readFileSync(dbPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    // se arquivo não existir ou estiver corrompido, recria estrutura
    const initial = { usuarios: [], chats: [], mensagens: [] };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function writeDB(obj) {
  fs.writeFileSync(dbPath, JSON.stringify(obj, null, 2), "utf-8");
}

module.exports = { readDB, writeDB };
