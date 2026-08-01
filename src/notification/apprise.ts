import { spawn, type ChildProcess } from 'node:child_process'
import { logToFile } from '../logging/logger.js'

// Priority is recorded locally for the dashboard notification log. Apprise
// itself does not have a single global priority flag — priority is conveyed
// per-service via query parameters on each Apprise URL (e.g.
// `ntfy://.../topic?priority=high`). The local priority here is purely
// cosmetic so the existing notification log keeps its colouring.
const PRIORITY_LABELS = ['default', 'low', 'high', 'urgent'] as const
type PriorityLabel = (typeof PRIORITY_LABELS)[number]

export interface NotificationEntry {
  timestamp: number
  title: string
  message: string
  priority: string
}

// The `apprise` binary can be overridden via env, mainly for non-container
// installs that put it somewhere unusual or use a venv wrapper.
const APPRISE_BIN = process.env.APPRISE_BIN || 'apprise'

// Apprise URLs can be separated by whitespace, commas, or newlines. Apprise
// URLs themselves never contain unescaped spaces, so this split is safe.
function parseUrls(value: string): string[] {
  return (value || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export class AppriseNotifier {
  private urls: string[]
  private history: NotificationEntry[] = []
  private missingLogged = false

  constructor(notifyUrls?: string) {
    this.urls = parseUrls(notifyUrls ?? '')
  }

  updateUrl(notifyUrls: string): void {
    this.urls = parseUrls(notifyUrls ?? '')
  }

  get enabled(): boolean {
    return this.urls.length > 0
  }

  getHistory(): NotificationEntry[] {
    return this.history
  }

  // Fire-and-forget: we spawn apprise, detach it from the event loop, and
  // return immediately so notification dispatch never blocks an in-flight
  // request (exhaustion events fire on the proxy's request path). Errors
  // surface only through the log file.
  private dispatch(title: string, message: string): void {
    if (!this.enabled) return
    const args = ['--title', title, '--body', message, ...this.urls]
    let child: ChildProcess
    try {
      child = spawn(APPRISE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      this.reportLaunchError(err)
      return
    }
    child.unref()

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') {
        this.reportMissingBinary()
      } else {
        logToFile('error', `Apprise error: ${err.message}`)
      }
    })
    child.on('close', (code) => {
      if (code !== null && code !== 0) {
        logToFile('error', `Apprise send failed (exit ${code})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`)
      }
    })
  }

  private reportLaunchError(err: unknown): void {
    logToFile('error', `Apprise could not be launched: ${err instanceof Error ? err.message : String(err)}`)
  }

  private reportMissingBinary(): void {
    if (this.missingLogged) return
    this.missingLogged = true
    logToFile(
      'error',
      `Apprise binary not found ("${APPRISE_BIN}"). Notifications will not be delivered. ` +
        `Install it on the host (e.g. "pip install apprise" / "pipx install apprise") or use the bundled Docker image.`,
    )
  }

  async send(title: string, message: string, priority: PriorityLabel = 'default'): Promise<void> {
    this.history.push({ timestamp: Date.now(), title, message, priority })
    if (this.history.length > 50) this.history.shift()
    this.dispatch(title, message)
  }

  async keyExhausted(alias: string, statusCode: number, remainingKeys: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Key Exhausted: ${alias}`,
      `API key "${alias}" exhausted (HTTP ${statusCode}). ${remainingKeys > 0 ? `Failing over to next key (${remainingKeys} remaining).` : 'No backup keys available.'}`,
      remainingKeys > 0 ? 'high' : 'urgent',
    )
  }

  async allKeysExhausted(keyCount: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      'All API Keys Exhausted',
      `All ${keyCount} API key(s) are exhausted. No keys available for routing. Add new keys or wait for cooldown to reset.`,
      'urgent',
    )
  }

  async circuitTripped(alias: string, errors: number): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Circuit Breaker: ${alias}`,
      `Circuit breaker OPEN for key "${alias}" after ${errors} consecutive 5xx errors. Temporarily removing from pool.`,
      'high',
    )
  }

  async circuitRecovered(alias: string): Promise<void> {
    if (!this.enabled) return
    await this.send(
      `Circuit Recovered: ${alias}`,
      `Circuit breaker CLOSED for key "${alias}". Key is now available for routing.`,
      'low',
    )
  }
}