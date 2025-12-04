const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS для Render
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Настройки
app.use(cors({
  origin: "*",
  credentials: true
}));

app.use(express.json());

// ⚠️ ВАЖНО: Отдаем статические файлы
app.use(express.static(path.join(__dirname, '../public')));

// База данных
const db = new sqlite3.Database(':memory:');

// Инициализация БД
db.serialize(() => {
  // Таблица пользователей
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    tg_username TEXT,
    role TEXT DEFAULT 'user',
    avatar_color TEXT DEFAULT '#3498db',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_banned INTEGER DEFAULT 0
  )`);

  // Таблица инвайт-кодов
  db.run(`CREATE TABLE invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_by INTEGER,
    used_at DATETIME,
    is_active INTEGER DEFAULT 1
  )`);

  // Таблица сообщений
  db.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Первый админ-код
  db.run("INSERT OR IGNORE INTO invite_codes (code) VALUES ('ADMIN123')");
  console.log('✅ База данных инициализирована');
  console.log('🔑 Первый код: ADMIN123');
});

// Функции для работы с БД
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
      return res.json({ 
        success: false, 
        message: 'Неверный или уже использованный код' 
      });
    }
    
    res.json({ 
      success: true, 
      codeId: codes[0].id 
    });
  } catch (error) {
    console.error('Ошибка проверки кода:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Ошибка сервера' 
    });
  }
});

// 2. Регистрация после кода
app.post('/api/register', async (req, res) => {
  try {
    const { nickname, tgUsername, codeId } = req.body;
    
    if (!nickname || !tgUsername || !codeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Не все поля заполнены' 
      });
    }
    
    // Генерируем случайный цвет для аватара
    const colors = ['#3498db', '#2ecc71', '#e74c3c', '#f39c12', '#9b59b6', '#1abc9c'];
    const avatarColor = colors[Math.floor(Math.random() * colors.length)];
    
    // Проверяем код
    const codes = await query("SELECT code FROM invite_codes WHERE id = ?", [codeId]);
    if (codes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Код не найден' 
      });
    }
    
    const isAdminCode = codes[0].code === 'ADMIN123';
    const role = isAdminCode ? 'admin' : 'user';
    
    // Создаем пользователя
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
    res.status(500).json({ 
      success: false, 
      message: 'Ошибка регистрации' 
    });
  }
});

// 3. Получить историю сообщений
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await query(`
      SELECT m.*, u.nickname, u.avatar_color, u.tg_username, u.role
      FROM messages m
      JOIN users u ON m.user_id = u.id
      ORDER BY m.timestamp DESC
      LIMIT 100
    `);
    
    res.json({ 
      success: true, 
      messages: messages.reverse() 
    });
    
  } catch (error) {
    console.error('Ошибка получения сообщений:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Ошибка получения сообщений' 
    });
  }
});

// 4. Простой тест API
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API работает!',
    timestamp: new Date().toISOString()
  });
});

// 5. Если запрос не на API и не статический файл - отдаем index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.includes('.')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

// ========== WebSocket (ЧАТ) ==========

io.on('connection', (socket) => {
  console.log('🔌 Новое подключение:', socket.id);
  
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
      socket.emit('error', { message: 'Ошибка загрузки истории' });
    }
  });
  
  // Новое сообщение
  socket.on('send_message', async (data) => {
    try {
      const { userId, text } = data;
      const trimmedText = text.trim();
      
      if (!trimmedText || !userId) {
        return;
      }
      
      // Проверяем не забанен ли пользователь
      const users = await query(
        "SELECT is_banned FROM users WHERE id = ?", 
        [userId]
      );
      
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
      
      if (sender.length === 0) {
        return;
      }
      
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
      socket.emit('error', { message: 'Ошибка отправки' });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Отключение:', socket.id);
  });
});

// ========== ЗАПУСК СЕРВЕРА ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔗 Доступен по: http://localhost:${PORT}`);
  console.log(`🌐 Или по: https://acarius-chat.onrender.com`);
});
