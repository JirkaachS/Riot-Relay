'use strict';

const crypto = require('crypto');

const RP_ID = 'localhost';
const pending = new Map();
let expectedOrigin = '';

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function decode(value, maxBytes = 8192) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Windows Hello returned malformed data.');
  const buffer = Buffer.from(value, 'base64url');
  if (!buffer.length || buffer.length > maxBytes || b64url(buffer) !== value) throw new Error('Windows Hello returned malformed data.');
  return buffer;
}

function configure(origin) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' || parsed.hostname !== RP_ID) throw new Error('Windows Hello requires the local trusted app origin.');
  expectedOrigin = parsed.origin;
}

function issue(purpose, extra = {}) {
  if (!expectedOrigin) throw new Error('Windows Hello is not initialized.');
  const challenge = b64url(crypto.randomBytes(32));
  pending.set(purpose, { challenge, expiresAt: Date.now() + 90000, ...extra });
  return challenge;
}

function consumeClientData(purpose, encoded, expectedType) {
  const request = pending.get(purpose);
  pending.delete(purpose);
  if (!request || request.expiresAt < Date.now()) throw new Error('Windows Hello request expired. Try again.');
  const raw = decode(encoded, 4096);
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Windows Hello returned invalid client data.'); }
  if (data.type !== expectedType || data.challenge !== request.challenge || data.origin !== expectedOrigin || data.crossOrigin === true) {
    throw new Error('Windows Hello response did not match this Riot Relay request.');
  }
  return { request, raw };
}

function verifyAuthenticatorData(encoded) {
  const data = decode(encoded, 4096);
  if (data.length < 37) throw new Error('Windows Hello authenticator data is incomplete.');
  const expectedRpHash = crypto.createHash('sha256').update(RP_ID).digest();
  if (!crypto.timingSafeEqual(data.subarray(0, 32), expectedRpHash)) throw new Error('Windows Hello relying party did not match Riot Relay.');
  const flags = data[32];
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new Error('Windows Hello did not verify the Windows user.');
  return data;
}

function normalizeCredential(value) {
  const credential = value && typeof value === 'object' ? value : {};
  const id = b64url(decode(credential.id, 1024));
  const publicKey = b64url(decode(credential.publicKey, 4096));
  const algorithm = Number(credential.algorithm);
  if (![-7, -257].includes(algorithm)) throw new Error('Windows Hello used an unsupported key algorithm.');
  crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  return { id, publicKey, algorithm };
}
function beginRegistration() {
  return {
    challenge: issue('register'),
    rp: { id: RP_ID, name: 'Riot Relay' },
    user: { id: b64url(crypto.randomBytes(32)), name: 'riot-relay-vault', displayName: 'Riot Relay vault' },
    timeout: 60000,
  };
}

function finishRegistration(response) {
  consumeClientData('register', response && response.clientDataJSON, 'webauthn.create');
  verifyAuthenticatorData(response && response.authenticatorData);
  return normalizeCredential(response);
}

function beginAuthentication(credential) {
  const normalized = normalizeCredential(credential);
  return {
    challenge: issue('authenticate', { credentialId: normalized.id }),
    rpId: RP_ID,
    credentialId: normalized.id,
    timeout: 60000,
  };
}

function finishAuthentication(response, credential) {
  const normalized = normalizeCredential(credential);
  const { request, raw: clientData } = consumeClientData('authenticate', response && response.clientDataJSON, 'webauthn.get');
  if (request.credentialId !== normalized.id || response.id !== normalized.id) throw new Error('Windows Hello credential did not match this vault.');
  const authenticatorData = verifyAuthenticatorData(response.authenticatorData);
  const signature = decode(response.signature, 4096);
  const signed = Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientData).digest()]);
  const publicKey = crypto.createPublicKey({ key: Buffer.from(normalized.publicKey, 'base64url'), format: 'der', type: 'spki' });
  if (!crypto.verify('sha256', signed, publicKey, signature)) throw new Error('Windows Hello signature verification failed.');
  return true;
}

module.exports = {
  configure,
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
  normalizeCredential,
};
