import assert from 'node:assert/strict';
import { isTrustedLocalRequest } from '../lib/local-access.mjs';

const req = (host, origin) => ({
  socket: { localPort: 8777 },
  headers: { host, ...(origin === undefined ? {} : { origin }) },
});

assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777')), true);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777', 'http://127.0.0.1:8777')), true);
assert.equal(isTrustedLocalRequest(req('localhost:8777', 'http://localhost:8777')), true);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777', 'https://example.com')), false);
assert.equal(isTrustedLocalRequest(req('attacker.example:8777', 'http://attacker.example:8777')), false);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:1234')), false);
assert.equal(isTrustedLocalRequest(req('127.0.0.1:8777', 'null')), false);
console.log('PASS local Host and browser Origin restriction');
