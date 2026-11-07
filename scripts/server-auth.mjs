// Test helper for talking to a running server.mjs that requires its
// per-launch access token. Spawned servers report it in MIAOJI_READY; servers
// started by hand can be pinned with MIAOJI_ACCESS_TOKEN in both shells.

// Adds the Bearer header to every fetch aimed at the server's origin, leaving
// requests to mock providers untouched.
export function useServerToken(base, token = process.env.MIAOJI_ACCESS_TOKEN) {
  if (!token) throw new Error('缺少访问令牌：请在启动服务和运行脚本时设置相同的 MIAOJI_ACCESS_TOKEN');
  const origin = new URL(base).origin;
  const plain = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin) return plain(input, init);
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + token);
    return plain(input, { ...init, headers });
  };
  return token;
}

// Node's WebSocket cannot set headers, so the token travels in the URL.
export function socketUrl(href, token) {
  const url = new URL(String(href).replace(/^http/, 'ws'));
  url.searchParams.set('token', token);
  return url.href;
}
