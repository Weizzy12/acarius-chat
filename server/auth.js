const { query } = require('./database');

// Простая проверка сессии (для демо)
const sessions = {};

async function checkAdmin(req) {
  const userId = req.session?.userId;
  if (!userId) return false;
  
  const users = await query("SELECT role FROM users WHERE id = ?", [userId]);
  return users.length > 0 && users[0].role === 'admin';
}

async function getUserProfile(userId) {
  const users = await query(
    "SELECT id, nickname, tg_username, role, avatar_color FROM users WHERE id = ?",
    [userId]
  );
  return users.length > 0 ? users[0] : null;
}

module.exports = { checkAdmin, getUserProfile, sessions };