const crypto = require('crypto')

const SCRYPT_SALT_PREFIX = 'walkie-hardened:v1'
const SCRYPT_KEYLEN = 32
const SCRYPT_COST = 16384  // N
const SCRYPT_BLOCK = 8     // r
const SCRYPT_PARALLEL = 1  // p

function deriveTopic(channel, secret) {
  const salt = `${SCRYPT_SALT_PREFIX}:${channel}`
  return crypto.scryptSync(secret, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL
  })
}

function validateSecret(secret) {
  if (!secret || secret.length < 16) {
    return { valid: false, message: 'Secret must be at least 16 characters. Use `walkie keygen` to generate one.' }
  }
  return { valid: true }
}

function generateSecret() {
  return crypto.randomBytes(16).toString('hex')
}

function agentId() {
  return crypto.randomBytes(4).toString('hex')
}

module.exports = { deriveTopic, validateSecret, generateSecret, agentId }
