const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);

// ИЗМЕНИЛ CORS для работы на Render
const io = socketIo(server, {
  cors: {
    origin: "*", // Разрешаем все домены для Render
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Настройки для Render
app.use(cors({
  origin: "*",
  credentials: true
}));

app.use(express.json());

// УКАЖИ ПРАВИЛЬНЫЙ ПУТЬ К ФРОНТЕНДУ
app.use(express.static(path.join(__dirname, '../public')));

// ========== БАЗА ДАННЫХ (упрощенная версия) ==========

// Используем SQLite в памяти для простоты
const db = new sqlite3.Database(':memory:');

// Инициализация БД
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    tg_username TEXT,
    role TEXT DEFAULT 'user',
    avatar_color TEXT DEFAULT '#3498db',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_banned INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_by INTEGER,
    used_at DATETIME,
    is_active INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Первый админ-код
  db.run("INSERT OR IGNORE INTO invite_codes (code) VALUES ('ADMIN123')");
});

// Простые функции для работы с БД
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

// ========== API РОУТЫ ==========

// 1. Проверка инвайт-кода
app.post('/api/check-code', async (req, res) => {
  try {
    const { code } = req.body;
    
    const codes = await query(
      "SELECT * FROM invite_codes WHERE code = ? AND is_active = 1 AND used_by IS NULL",
      [code]
    );
    
    if (codes.length === 0) {
      return res.json({ success: false, message: 'Неверный или уже использованный код' });
    }
    
    res.json({ success: true, codeId: codes[0].id });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// 2. Регистрация после кода
app.post('/api/register', async (req, res) => {
  try {
    const { nickname, tgUsername, codeId } = req.body;
    
    // Создаем пользователя
    const avatarColor = getRandomColor();
    const role = (await query("SELECT code FROM invite_codes WHERE id = ?", [codeId]))[0].code === 'ADMIN123' ? 'admin' : 'user';
    
    const result = await run(
      "INSERT INTO users (nickname, tg_username, avatar_color, role) VALUES (?, ?, ?, ?)",
      [nickname, tgUsername, avatarColor, role]
    );
    
    const userId = result.id;
    
    // Помечаем код как использованный
    await run(
      "UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE id = ?",
      [userId, codeId]
    );
    
    res.json({ 
      success: true, 
      user: { 
        id: userId, 
        nickname, 
        tg_username: tgUsername, 
        role, 
        avatar_color: avatarColor 
      }
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ success: false, message: 'Ошибка регистрации' });
  }
});

// 3. Получить данные пользователя (упрощенно)
app.get('/api/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const users = await query(
      "SELECT id, nickname, tg_username, role, avatar_color FROM users WHERE id = ?",
      [id]
    );
    
    if (users.length > 0) {
      res.json({ success: true, user: users[0] });
    } else {
      res.json({ success: false, message: 'Пользователь не найден' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// 4. АДМИН: Генерация инвайт-кода
app.post('/api/admin/generate-code', async (req, res) => {
  try {
    const { userId } = req.body;
    
    // Проверяем админа
    const users = await query("SELECT role FROM users WHERE id = ?", [userId]);
    if (users.length === 0 || users[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Требуются права админа' });
    }
    
    // Генерируем код
    const code = 'CHAT-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    await run(
      "INSERT INTO invite_codes (code, created_by) VALUES (?, ?)",
      [code, userId]
    );
    
    res.json({ success: true, code });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// 5. АДМИН: Получить все коды
app.get('/api/admin/codes', async (req, res) => {
  try {
    const { adminId } = req.query;
    
    // Проверяем админа
    const users = await query("SELECT role FROM users WHERE id = ?", [adminId]);
    if (users.length === 0 || users[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Требуются права админа' });
    }
    
    const codes = await query(`
      SELECT ic.*, u.nickname as used_by_nickname 
      FROM invite_codes ic
      LEFT JOIN users u ON ic.used_by = u.id
      ORDER BY ic.created_at DESC
    `);
    
    res.json({ success: true, codes });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// 6. АДМИН: Получить всех пользователей
app.get('/api/admin/users', async (req, res) => {
  try {
    const { adminId } = req.query;
    
    // Проверяем админа
    const users = await query("SELECT role FROM users WHERE id = ?", [adminId]);
    if (users.length === 0 || users[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Требуются права админа' });
    }
    
    const allUsers = await query(`
      SELECT id, nickname, tg_username, role, avatar_color, 
             created_at, is_banned,
             (SELECT COUNT(*) FROM messages WHERE user_id = users.id) as message_count
      FROM users
      ORDER BY created_at DESC
    `);
    
    res.json({ success: true, users: allUsers });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// 7. АДМИН: Бан пользователя
app.post('/api/admin/ban-user', async (req, res) => {
  try {
    const { adminId, userId, action } = req.body;
    
    // Проверяем админа
    const admin = await query("SELECT role FROM users WHERE id = ?", [adminId]);
    if (admin.length === 0 || admin[0].role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Требуются права админа' });
    }
    
    if (action === 'ban') {
      await run("UPDATE users SET is_banned = 1 WHERE id = ?", [userId]);
    } else if (action === 'unban') {
      await run("UPDATE users SET is_banned = 0 WHERE id = ?", [userId]);
    } else if (action === 'make_admin') {
      await run("UPDATE users SET role = 'admin' WHERE id = ?", [userId]);
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// 8. Получить историю сообщений
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await query(`
      SELECT m.*, u.nickname, u.avatar_color, u.tg_username, u.role
      FROM messages m
      JOIN users u ON m.user_id = u.id
      ORDER BY m.timestamp DESC
      LIMIT 100
    `);
    
    res.json({ success: true, messages: messages.reverse() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// ========== WebSocket (ЧАТ) ==========

io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);
  
  // Отправляем историю сообщений
  socket.on('get_history', async () => {
    try {
      const messages = await query(`
        SELECT m.*, u.nickname, u.avatar_color, u.tg_username, u.role
        FROM messages m
        JOIN users u ON m.user_id = u.id
        ORDER BY m.timestamp DESC
        LIMIT 100
      `);
      
      socket.emit('message_history', messages.reverse());
    } catch (error) {
      console.error('Ошибка получения истории:', error);
    }
  });
  
  // Новое сообщение
  socket.on('send_message', async (data) => {
    try {
      const { userId, text } = data;
      const trimmedText = text.trim();
      
      if (!trimmedText) return;
      
      // Проверяем не забанен ли пользователь
      const users = await query("SELECT is_banned FROM users WHERE id = ?", [userId]);
      if (users.length > 0 && users[0].is_banned) {
        socket.emit('error', { message: 'Вы забанены' });
        return;
      }
      
      // Сохраняем в БД
      const result = await run(
        "INSERT INTO messages (user_id, text) VALUES (?, ?)",
        [userId, trimmedText]
      );
      
      // Получаем данные отправителя
      const sender = await query(
        "SELECT id, nickname, tg_username, avatar_color, role FROM users WHERE id = ?",
        [userId]
      );
      
      // Рассылаем всем
      const messageData = {
        id: result.id,
        text: trimmedText,
        user: sender[0],
        timestamp: new Date().toISOString()
      };
      
      io.emit('new_message', messageData);
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Отключение:', socket.id);
  });
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function getRandomColor() {
  const colors = [
    '#3498db', '#2ecc71', '#e74c3c', '#f39c12', 
    '#9b59b6', '#1abc9c', '#d35400', '#34495e'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ========== ЗАПУСК СЕРВЕРА ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔗 Доступен по: http://localhost:${PORT}`);
  console.log(`🔑 Первый код: ADMIN123`);
});