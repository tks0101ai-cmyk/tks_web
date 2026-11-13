'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, comparePassword, signToken, verifyToken } = require('./authService');

test('hashPassword + comparePassword: mat khau dung tra ve true', async () => {
  const hash = await hashPassword('MatKhau123!');
  assert.equal(await comparePassword('MatKhau123!', hash), true);
});

test('hashPassword + comparePassword: mat khau sai tra ve false', async () => {
  const hash = await hashPassword('MatKhau123!');
  assert.equal(await comparePassword('sai-mat-khau', hash), false);
});

test('comparePassword: khong throw khi passwordHash rong/undefined (user khong ton tai)', async () => {
  assert.equal(await comparePassword('bat-ky', ''), false);
  assert.equal(await comparePassword('bat-ky', undefined), false);
});

test('signToken + verifyToken: round-trip giu nguyen payload', () => {
  const payload = { id: '1', username: 'ketoan1', hoTen: 'Kế Toán A', vaiTro: 'Kế toán', coSo: 'An Khánh' };
  const token = signToken(payload);
  const decoded = verifyToken(token);
  assert.equal(decoded.id, payload.id);
  assert.equal(decoded.username, payload.username);
  assert.equal(decoded.vaiTro, payload.vaiTro);
});

test('verifyToken: throw voi token gia mao/khong hop le', () => {
  assert.throws(() => verifyToken('token-khong-hop-le'));
});

test('verifyToken: throw voi token ky bang secret khac', () => {
  const jwt = require('jsonwebtoken');
  const foreignToken = jwt.sign({ id: '1' }, 'secret-khac-hoan-toan');
  assert.throws(() => verifyToken(foreignToken));
});

const CONFIG = require('../config');

test('signToken: han JWT bang AUTH_SESSION_TTL_MS', () => {
  const decoded = verifyToken(signToken({ id: '1' }));
  assert.equal(decoded.exp - decoded.iat, Math.floor(CONFIG.AUTH_SESSION_TTL_MS / 1000));
});

function loadConfigWithIdleDays(value) {
  const configPath = require.resolve('../config');
  const saved = process.env.AUTH_SESSION_IDLE_DAYS;
  delete require.cache[configPath];
  if (value === undefined) delete process.env.AUTH_SESSION_IDLE_DAYS;
  else process.env.AUTH_SESSION_IDLE_DAYS = value;
  try {
    return require('../config');
  } finally {
    delete require.cache[configPath];
    if (saved === undefined) delete process.env.AUTH_SESSION_IDLE_DAYS;
    else process.env.AUTH_SESSION_IDLE_DAYS = saved;
  }
}

test('config: AUTH_SESSION_IDLE_DAYS mac dinh 7 ngay', () => {
  const cfg = loadConfigWithIdleDays(undefined);
  assert.equal(cfg.AUTH_SESSION_IDLE_DAYS, 7);
  assert.equal(cfg.AUTH_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('config: AUTH_SESSION_IDLE_DAYS hop le duoc dung', () => {
  const cfg = loadConfigWithIdleDays('30');
  assert.equal(cfg.AUTH_SESSION_IDLE_DAYS, 30);
  assert.equal(cfg.AUTH_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test('config: AUTH_SESSION_IDLE_DAYS rac -> 7', () => {
  for (const bad of ['', 'abc', '0', '-3', '1.5']) {
    assert.equal(loadConfigWithIdleDays(bad).AUTH_SESSION_IDLE_DAYS, 7, `gia tri ${JSON.stringify(bad)}`);
  }
});

test('config: khong con JWT_EXPIRES_IN', () => {
  assert.equal('JWT_EXPIRES_IN' in loadConfigWithIdleDays(undefined), false);
});
