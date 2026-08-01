import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { StoredApiKey } from '../router/types.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const SALT_LENGTH = 32
const PBKDF2_ITERATIONS = 600_000
const DIGEST = 'sha512'

interface EncryptedPayload {
  salt: string
  iv: string
  tag: string
  data: string
}

export class SecureStore {
  private readonly filePath: string
  private readonly masterKeyPath: string
  private masterKey?: Buffer

  constructor(configDir: string) {
    const dir = configDir || path.join(os.homedir(), '.opencode')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.filePath = path.join(dir, 'router-keys.enc')
    // The AES master key is a persistent 32-byte random key stored next to the
    // encrypted key file. Deriving it from os.hostname() + username tied the
    // key store to the machine identity, which broke decryption every time the
    // container was recreated (Docker gives each container a fresh hostname =
    // its short container id). Keeping the master key in CONFIG_DIR (a mounted
    // volume in Docker, ~/.opencode otherwise) makes the store stable across
    // rebuilds/restarts/container recreations while staying unreadable without
    // access to that file.
    this.masterKeyPath = path.join(dir, 'router-master.key')
  }

  // Returns the 32-byte AES key, generating + persisting it on first use.
  private getOrCreateMasterKey(): Buffer {
    if (this.masterKey) return this.masterKey

    if (fs.existsSync(this.masterKeyPath)) {
      try {
        const buf = Buffer.from(fs.readFileSync(this.masterKeyPath, 'utf8').trim(), 'hex')
        if (buf.length === KEY_LENGTH) {
          this.masterKey = buf
          return this.masterKey
        }
      } catch {
        // fall through to generating a fresh key
      }
    }

    const buf = crypto.randomBytes(KEY_LENGTH)
    try {
      fs.writeFileSync(this.masterKeyPath, buf.toString('hex'), { mode: 0o600 })
    } catch {
      // If the master key can't be persisted, keep it in memory only: keys
      // still work for this process lifetime but won't survive a restart.
      // Better than crashing — the dashboard can show the failure.
    }
    this.masterKey = buf
    return this.masterKey
  }

  // Legacy key derivation (machine identity). Kept only to migrate stores
  // encrypted by previous versions before the persistent master key existed.
  private legacyDeriveKey(): Buffer {
    const machineId = `${os.hostname()}-${os.userInfo().username}`
    const salt = crypto.createHash('sha256').update(machineId).digest().subarray(0, SALT_LENGTH)
    return crypto.pbkdf2Sync(machineId, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST)
  }

  private decryptWith(payload: EncryptedPayload, key: Buffer): StoredApiKey[] | null {
    try {
      const iv = Buffer.from(payload.iv, 'hex')
      const tag = Buffer.from(payload.tag, 'hex')
      const encrypted = Buffer.from(payload.data, 'hex')

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
      const parsed = JSON.parse(decrypted.toString('utf8'))
      if (!Array.isArray(parsed)) return null

      return parsed
        .map((entry) => this.normalizeEntry(entry))
        .filter((entry): entry is StoredApiKey => entry !== null)
    } catch {
      return null
    }
  }

  async saveKeys(keys: StoredApiKey[]): Promise<void> {
    const key = this.getOrCreateMasterKey()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const salt = crypto.randomBytes(SALT_LENGTH)

    const plaintext = JSON.stringify(keys)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    const payload: EncryptedPayload = {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex'),
    }

    fs.writeFileSync(this.filePath, JSON.stringify(payload), 'utf8')
  }

  async loadKeys(): Promise<StoredApiKey[]> {
    if (!fs.existsSync(this.filePath)) return []

    let payload: EncryptedPayload
    try {
      payload = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      return []
    }

    // Primary path: the persistent master key.
    const primary = this.decryptWith(payload, this.getOrCreateMasterKey())
    if (primary !== null) return primary

    // Migration: a store encrypted under the old machine-identity key (e.g.
    // created before the master-key file existed, or on a container that was
    // recreated). Decrypt with the legacy key, then re-encrypt under the new
    // persistent master key so future loads are stable across hostname
    // changes.
    const legacy = this.decryptWith(payload, this.legacyDeriveKey())
    if (legacy !== null && legacy.length > 0) {
      try {
        await this.saveKeys(legacy)
      } catch {
        // re-encryption is best-effort; the in-memory list is still returned
      }
      return legacy
    }

    return []
  }

  async addKey(entry: StoredApiKey): Promise<void> {
    const keys = await this.loadKeys()
    keys.push(entry)
    await this.saveKeys(keys)
  }

  async removeKey(id: string): Promise<void> {
    let keys = await this.loadKeys()
    keys = keys.filter(k => k.id !== id)
    await this.saveKeys(keys)
  }

  async updateKey(entry: StoredApiKey): Promise<void> {
    const keys = await this.loadKeys()
    const idx = keys.findIndex(key => key.id === entry.id)
    if (idx === -1) {
      keys.push(entry)
    } else {
      keys[idx] = entry
    }
    await this.saveKeys(keys)
  }

  private normalizeEntry(entry: unknown): StoredApiKey | null {
    if (!entry || typeof entry !== 'object') return null
    const value = entry as Record<string, unknown>
    const key = typeof value.key === 'string' ? value.key : null
    const alias = typeof value.alias === 'string' && value.alias.trim() ? value.alias : null
    if (!key || !alias) return null

    return {
      id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
      key,
      alias,
      addedAt: typeof value.addedAt === 'number' ? value.addedAt : Date.now(),
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      priority: typeof value.priority === 'number' && Number.isFinite(value.priority) ? value.priority : 1,
      weight: typeof value.weight === 'number' && Number.isFinite(value.weight) ? value.weight : 1,
      ...(typeof value.goUsageWorkspaceId === 'string' && value.goUsageWorkspaceId ? { goUsageWorkspaceId: value.goUsageWorkspaceId } : {}),
      ...(typeof value.goUsageAuthCookie === 'string' && value.goUsageAuthCookie ? { goUsageAuthCookie: value.goUsageAuthCookie } : {}),
    }
  }

  keyExists(): boolean {
    return fs.existsSync(this.filePath)
  }
}
