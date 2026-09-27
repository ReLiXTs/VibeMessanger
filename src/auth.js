import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function createToken(payload, secret, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function validateCredentials(username, password) {
  const errors = [];
  if (typeof username !== "string" || !/^[a-zA-Z0-9_.-]{3,20}$/.test(username.trim())) {
    errors.push("Имя пользователя: 3-20 символов (буквы, цифры, _ . -)");
  }
  if (typeof password !== "string" || password.length < 6) {
    errors.push("Пароль: минимум 6 символов");
  }
  return errors;
}
