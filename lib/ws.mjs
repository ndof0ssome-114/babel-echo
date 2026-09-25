// ws.mjs — a dependency-free RFC 6455 WebSocket server.
//
// DSH's sandbox makes package installs awkward, and the only thing we need
// from a WS library is upgrade handling plus frame parsing. Everything the
// realtime transcript needs is right here: text/binary frames, fragmentation,
// control frames, and ping/pong keepalive.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Build a single unmasked server->client frame. */
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export class WebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.isAlive = true;
    this.data = {}; // scratch space for the application

    socket.on('data', (chunk) => {
      this.isAlive = true;
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      try {
        this.drain();
      } catch (err) {
        this.close(1002, 'protocol error');
        this.emitError(err);
      }
    });
    socket.on('close', () => this.finish());
    socket.on('error', (err) => {
      this.emitError(err);
      this.finish();
    });

    this.keepalive = setInterval(() => {
      if (this.closed) return;
      if (!this.isAlive) return this.close(1001, 'idle');
      this.isAlive = false;
      this.ping();
    }, 25000);
    if (this.keepalive.unref) this.keepalive.unref();
  }

  /**
   * Emitting 'error' on an EventEmitter with no listener THROWS, which would
   * take the whole server (and every in-progress meeting) down whenever a
   * browser tab closes mid-socket. Only emit when somebody is listening.
   */
  emitError(err) {
    if (this.listenerCount('error')) this.emit('error', err);
    else this.lastError = err;
  }

  drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009, 'message too big');
        len = Number(big);
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return;

      let payload = this.buf.subarray(offset, offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this.buf = this.buf.subarray(offset + len);

      // Client frames must be masked.
      if (!masked) return this.close(1002, 'unmasked frame');

      this.handle(opcode, fin, payload);
    }
  }

  handle(opcode, fin, payload) {
    if (opcode === OP_CLOSE) {
      this.close(1000, '');
      return;
    }
    if (opcode === OP_PING) {
      this.sendFrame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) return;

    if (opcode === OP_CONT) {
      this.fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(this.fragments);
        const op = this.fragOpcode;
        this.fragments = [];
        this.fragOpcode = 0;
        this.deliver(op, whole);
      }
      return;
    }

    if (!fin) {
      this.fragOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    this.deliver(opcode, payload);
  }

  deliver(opcode, payload) {
    if (opcode === OP_TEXT) this.emit('message', payload.toString('utf8'), false);
    else if (opcode === OP_BIN) this.emit('message', payload, true);
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(frame(opcode, payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a text frame. Objects are JSON-encoded. */
  send(data) {
    if (typeof data !== 'string') data = JSON.stringify(data);
    return this.sendFrame(OP_TEXT, Buffer.from(data, 'utf8'));
  }

  /** Send a binary frame. */
  sendBinary(buf) {
    return this.sendFrame(OP_BIN, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  ping() {
    this.sendFrame(OP_PING, Buffer.alloc(0));
  }

  close(code, reason) {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason || ''));
    body.writeUInt16BE(code || 1000, 0);
    if (reason) body.write(reason, 2, 'utf8');
    this.sendFrame(OP_CLOSE, body);
    this.finish();
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    this.emit('close');
  }
}

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 * Returns the set of live connections so the app can broadcast.
 */
export function attachWebSocket(server, options) {
  const path = options.path || '/ws';
  const onConnection = options.onConnection;
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (options.allowRequest && !options.allowRequest(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const ws = new WebSocket(socket);
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    try {
      onConnection(ws, req, url);
    } catch (err) {
      ws.close(1011, 'handler failed');
    }
  });

  return { clients };
}
