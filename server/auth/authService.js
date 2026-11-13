// ==========================================
// AUTH SERVICE — bam mat khau (bcrypt) va ky/xac thuc JWT.
// Khong bao gio import truc tiep tu route — di qua authMiddleware/authRoutes.
// ==========================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CONFIG = require('../config');

const BCRYPT_SALT_ROUNDS = 10;

function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
}

function comparePassword(plainPassword, passwordHash) {
  if (!passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plainPassword, passwordHash);
}

/**
 * payload toi thieu can cho phan quyen: id, username, hoTen, vaiTro, coSo.
 * KHONG duoc dua passwordHash vao token.
 */
function signToken(payload) {
  return jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: Math.floor(CONFIG.AUTH_SESSION_TTL_MS / 1000) });
}

/**
 * Tra ve payload da giai ma neu token hop le, nguoc lai throw (JsonWebTokenError/TokenExpiredError).
 */
function verifyToken(token) {
  return jwt.verify(token, CONFIG.JWT_SECRET);
}

module.exports = { hashPassword, comparePassword, signToken, verifyToken };
