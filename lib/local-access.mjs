import { randomBytes, timingSafeEqual } from 'node:crypto';

// The server only listens on loopback, but loopback is shared by every local
// process and every OS user on the machine, and browsers send no Origin on
// cross-site GETs such as <img src>. Two layers therefore guard each request:
//   1. Loopback Host plus same-origin Origin blocks DNS rebinding and
//      cross-site browser writes, including WebSocket upgrades.
//   2. A per-launch access token proves the caller was handed it by whoever
//      started the server (the Electron shell, or the terminal that printed
//      the link).
export function isTrustedLocalRequest(req) {
  const port = req.socket?.localPort;
  if (!Number.isInteger(port)) return false;
  const authority = String(req.headers.host || '').toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  if (!allowed.has(authority)) return false;

  const origin = req.headers.origin;
  if (!origin) return true; // Native clients and local scripts need no Origin.
  return String(origin).toLowerCase() === `http://${authority}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

// MIAOJI_ACCESS_TOKEN lets test scripts pin the token. It is removed from the
// environment so ffmpeg and other children never inherit it.
export function resolveAccessToken(env = process.env) {
  const supplied = env.MIAOJI_ACCESS_TOKEN;
  delete env.MIAOJI_ACCESS_TOKEN;
  if (supplied === undefined || supplied === '') return randomBytes(32).toString('base64url');
  if (!TOKEN_RE.test(supplied)) throw new Error('MIAOJI_ACCESS_TOKEN 必须是 32–256 位字母、数字、- 或 _');
  return supplied;
}

// Cookies are not port-scoped, so the name carries the port to keep two
// local copies (browser mode and the desktop app) from overwriting each other.
export const accessCookieName = (port) => `babel_echo_access_${port}`;

export function accessCookieHeader(port, token) {
  return `${accessCookieName(port)}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

function sameToken(candidate, token) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Returns how the request proved access: 'header', 'cookie', 'query', or null.
// A query token is only honoured where the caller cannot set headers or
// cookies yet (page links and WebSocket URLs); API calls must use a header
// or the cookie so the token does not linger in URLs.
export function requestAccess(req, url, token, { allowQuery = false } = {}) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer /i.test(auth) && sameToken(auth.slice(7).trim(), token)) return 'header';
  const port = req.socket?.localPort;
  if (Number.isInteger(port) && sameToken(cookieValue(req.headers.cookie, accessCookieName(port)), token)) return 'cookie';
  if (allowQuery && sameToken(url.searchParams.get('token'), token)) return 'query';
  return null;
}
