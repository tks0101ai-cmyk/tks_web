'use strict';

// API NOI BO KIOTVIET (api-man1 — chinh API trang quan ly KiotViet dung). Chi dung de doc THU TU DONG THAT cua don dat
// hang: Public API tra `orderDetails` sap theo productId va khong co Id dong, con man hinh/ban in Kiot sap theo Id dong
// (thu tu sale nhap). Dang nhap bang tai khoan web KiotViet rieng (KIOTVIET_WEB_USERNAME/PASSWORD[_SG]).
// API khong duoc KiotViet cam ket — moi loi deu de nguoi goi xu ly fail-soft (giu thu tu Public API).
const crypto = require('crypto');

const API_URL = 'https://api-man1.kiotviet.vn';

function credentialsFor(branch, env = process.env) {
  const suffix = branch === 'saigon' ? '_SG' : '';
  const userName = env[`KIOTVIET_WEB_USERNAME${suffix}`];
  const password = env[`KIOTVIET_WEB_PASSWORD${suffix}`];
  const retailer = branch === 'saigon' ? env.KIOTVIET_RETAILER_SG : env.KIOTVIET_RETAILER;
  return userName && password && retailer ? { userName, password, retailer } : null;
}

function createKiotInternalClient({ userName, password, retailer, fetchImpl = global.fetch, timeoutMs = 15000 }) {
  // Kiot gan phien voi "van tay" may; giu co dinh theo tai khoan de khong bi coi la thiet bi moi moi lan dang nhap.
  const fingerPrintKey = crypto.createHash('sha256').update(`tks-dashboard|${retailer}|${userName}`).digest('hex').slice(0, 32);
  let session = null; // { token, branchId }
  let loggingIn = null;

  async function request(method, path, { body, headers = {} } = {}) {
    const response = await fetchImpl(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Retailer: retailer, ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`KiotViet noi bo HTTP ${response.status}: ${text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  async function login() {
    const data = await request('POST', '/api/auth/salelogin?format=json',
      { body: { UserName: userName, Password: password, FingerPrintKey: fingerPrintKey } });
    const token = data && (data.BearerToken || data.bearerToken || data.token);
    if (!token) {
      const reason = (data && (data.error || data.ResponseStatus?.Message)) || 'khong co BearerToken (captcha/2FA?)';
      throw new Error(`Dang nhap KiotViet noi bo that bai: ${reason}`);
    }
    session = { token, branchId: data.CurrentBranchId ?? data.currentBranch ?? null };
    return session;
  }

  async function ensureSession(force = false) {
    if (session && !force) return session;
    if (!loggingIn) loggingIn = login().finally(() => { loggingIn = null; });
    return loggingIn;
  }

  async function authorizedGet(path) {
    const call = s => request('GET', path, { headers: { Authorization: `Bearer ${s.token}`, ...(s.branchId ? { BranchId: String(s.branchId) } : {}) } });
    try {
      return await call(await ensureSession());
    } catch (error) {
      if (error.status !== 401) throw error;
      return call(await ensureSession(true));
    }
  }

  /** Dong hang cua don theo thu tu Kiot (Id dong tang dan): [{ id, productId, quantity }]. */
  async function fetchOrderLines(orderId) {
    const data = await authorizedGet(`/api/orders/${encodeURIComponent(orderId)}/details?format=json`);
    const rows = Array.isArray(data && data.Data) ? data.Data : [];
    return rows
      .map(row => ({ id: Number(row.Id), productId: Number(row.ProductId), quantity: Number(row.Quantity) }))
      .sort((a, b) => a.id - b.id);
  }

  return { fetchOrderLines, login };
}

module.exports = { createKiotInternalClient, credentialsFor, API_URL };
