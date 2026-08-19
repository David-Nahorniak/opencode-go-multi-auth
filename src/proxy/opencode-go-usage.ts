// OpenCode Go plan usage checker.
//
// Calls the upstream usage API (GET <upstreamUrl>/usage, default
// https://opencode.ai/zen/go/v1/usage) authenticated with the account's
// Go API key. Returns rolling / weekly / monthly usage windows with
// percent-used and ISO reset timestamps.

export interface OpenCodeGoWindow {
  usagePercent: number
  percentRemaining: number
  resetInSec: number
  resetTimeIso: string
  status: string
}

export interface OpenCodeGoUsageResult {
  success: boolean
  configured: boolean
  fetchedAt: number
  // True when the API returned 401/403 — the API key is invalid or revoked.
  // The dashboard surfaces this as a "replace key" request.
  keyInvalid?: boolean
  // True when the key is valid but the account has no active Go plan.
  planNotActivated?: boolean
  rolling?: OpenCodeGoWindow
  weekly?: OpenCodeGoWindow
  monthly?: OpenCodeGoWindow
  error?: string
}

const DEFAULT_UPSTREAM_URL = 'https://opencode.ai/zen/go/v1'
const REQUEST_TIMEOUT_MS = 10_000

interface RawUsageWindow {
  status?: string
  percent?: number
  resetsAt?: string
}

interface RawUsageResponse {
  usage?: {
    rolling?: RawUsageWindow
    weekly?: RawUsageWindow
    monthly?: RawUsageWindow
  }
}

function normalizeWindow(raw: RawUsageWindow, now: number): OpenCodeGoWindow | null {
  if (!raw || typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) return null
  const usagePercent = Math.max(0, raw.percent)
  const resetTimeIso = typeof raw.resetsAt === 'string' ? raw.resetsAt : ''
  let resetInSec = 0
  if (resetTimeIso) {
    const resetMs = Date.parse(resetTimeIso)
    if (Number.isFinite(resetMs)) {
      resetInSec = Math.max(0, Math.round((resetMs - now) / 1000))
    }
  }
  return {
    usagePercent,
    resetInSec,
    percentRemaining: 100 - usagePercent,
    resetTimeIso,
    status: typeof raw.status === 'string' ? raw.status : '',
  }
}

export async function queryOpenCodeGoUsage(
  apiKey: string,
  options: { upstreamUrl?: string; requestTimeoutMs?: number } = {},
): Promise<OpenCodeGoUsageResult> {
  const now = Date.now()
  const base: OpenCodeGoUsageResult = { success: false, configured: true, fetchedAt: now }
  if (!apiKey) {
    return { ...base, configured: false, error: 'OpenCode Go API key is not configured' }
  }
  const baseUrl = (options.upstreamUrl || DEFAULT_UPSTREAM_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/usage`
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      const keyInvalid = res.status === 401 || res.status === 403
      return { ...base, keyInvalid, error: `Usage API returned HTTP ${res.status}` }
    }
    const body = await res.json() as RawUsageResponse
    const u = body?.usage
    if (!u) {
      return { ...base, planNotActivated: true, error: 'No active OpenCode Go plan on this account — enable the plan in opencode.ai or disable this account' }
    }

    const rolling = normalizeWindow(u.rolling ?? {}, now)
    const weekly = normalizeWindow(u.weekly ?? {}, now)
    const monthly = normalizeWindow(u.monthly ?? {}, now)

    if (!rolling && !weekly && !monthly) {
      return { ...base, planNotActivated: true, error: 'No active OpenCode Go plan on this account — enable the plan in opencode.ai or disable this account' }
    }

    return {
      ...base,
      success: true,
      ...(rolling ? { rolling } : {}),
      ...(weekly ? { weekly } : {}),
      ...(monthly ? { monthly } : {}),
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}
