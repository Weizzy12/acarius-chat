const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Создаем/подключаем базу данных
const db = new sqlite3.Database(path.join(__dirname, 'chat.db'), (err) => {
  if (err) {
    console.error('Ошибка подключения к БД:', err);
  } else {
    console.log('Подключен к SQLite базе данных');
    initDatabase();
  }
});

// Создаем таблицы, если их нет
function initDatabase() {
  // Таблица пользователей
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    tg_username TEXT,
    role TEXT DEFAULT 'user',
    avatar_color TEXT DEFAULT '#3498db',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_banned INTEGER DEFAULT 0
  )`);

  // Таблица инвайт-кодов
  db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_by INTEGER,
    used_at DATETIME,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
  )`);

  // Таблица сообщений
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // Создаем первого админа (если нет)
  db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1", (err, row) => {
    if (!row) {
      const adminCode = 'ADMIN-12345'; // Первый код для себя
      db.run("INSERT INTO invite_codes (code, created_by) VALUES (?, 0)", [adminCode]);
      console.log('Создан первый инвайт-код для админа:', adminCode);
    }
  });
}

// Функция для удобной работы с БД
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

module.exports = { db, query, run };