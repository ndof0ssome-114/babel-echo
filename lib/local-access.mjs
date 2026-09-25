// The beta server has no user authentication. Accept only loopback Host and
// same-origin browser requests, including WebSocket upgrades. This prevents
// other websites from issuing recording or file-import commands through a
// browser and blocks DNS rebinding to the local server.
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
