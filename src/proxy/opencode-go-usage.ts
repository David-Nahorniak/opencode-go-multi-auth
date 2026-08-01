// OpenCode Go plan usage scraper.
//
// There is no public usage API. PR anomalyco/opencode#16513 (adding
// GET /zen/go/v1/usage) has been open and unmerged since Mar 2026, and
// /zen/go/v1/usage still 404s in production. The only working source of
// rolling/weekly/monthly usage + reset times is the workspace dashboard
// page, which is a SolidJS SSR document. This scraper parses the usage
// windows out of that HTML the same way the established community tool
// slkiser/opencode-quota does (MIT), supporting both the SolidJS SSR
// hydration format and the newer data-slot HTML format.
//
// Auth is the opencode.ai account session cookie (from the OAuth login),
// not the Go API key. workspaceId is the segment in the workspace URL.

export interface OpenCodeGoWindow {
  usagePercent: number
  percentRemaining: number
  resetInSec: number
  resetTimeIso: string
}

export interface OpenCodeGoUsageResult {
  success: boolean
  configured: boolean
  fetchedAt: number
  // True when the scrape failed in a way that indicates the auth cookie is
  // expired/invalid (HTTP 401/403, or a login redirect that hid the usage
  // data). The dashboard surfaces this as a "renew cookie" request.
  cookieExpired?: boolean
  rolling?: OpenCodeGoWindow
  weekly?: OpenCodeGoWindow
  monthly?: OpenCodeGoWindow
  error?: string
}

const DASHBOARD_URL_PREFIX = 'https://opencode.ai/workspace/'
const DASHBOARD_URL_SUFFIX = '/go'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0'
const SCRAPE_TIMEOUT_MS = 10_000

const NUM = String.raw`(-?\d+(?:\.\d+)?)`

// SolidJS SSR hydration embeds `rollingUsage:$R[N]={...usagePercent:X...resetInSec:Y...}`.
// Field order varies, so try both orderings for each window.
function makeWindowRegexes(name: string) {
  return [
    new RegExp(String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${NUM}[^}]*resetInSec:${NUM}[^}]*\}`),
    new RegExp(String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${NUM}[^}]*usagePercent:${NUM}[^}]*\}`),
  ]
}

const RE = {
  rolling: makeWindowRegexes('rollingUsage'),
  weekly: makeWindowRegexes('weeklyUsage'),
  monthly: makeWindowRegexes('monthlyUsage'),
}

interface ScrapedWindow { usagePercent: number; resetInSec: number }

function parseSolidWindow(html: string, [pctFirst, resetFirst]: RegExp[]): ScrapedWindow | null {
  const m = pctFirst.exec(html)
  if (m) {
    const usagePercent = Number(m[1])
    const resetInSec = Number(m[2])
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec }
  }
  const m2 = resetFirst.exec(html)
  if (m2) {
    const resetInSec = Number(m2[1])
    const usagePercent = Number(m2[2])
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) return { usagePercent, resetInSec }
  }
  return null
}

function parseHumanTime(timeStr: string): number | null {
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, ' ')
  if (['reset-now', 'reset now', 'now', 'resets now'].includes(normalized)) return 0
  let total = 0
  let has = false
  const grab = (re: RegExp, mult: number) => {
    const mm = normalized.match(re)
    if (mm) { total += Number(mm[1]) * mult; has = true }
  }
  grab(/(\d+(?:\.\d+)?)\s*days?/, 86400)
  grab(/(\d+(?:\.\d+)?)\s*hours?/, 3600)
  grab(/(\d+(?:\.\d+)?)\s*minutes?/, 60)
  grab(/(\d+(?:\.\d+)?)\s*seconds?/, 1)
  return has ? total : null
}

function parseDataSlot(html: string): Partial<Record<'rolling' | 'weekly' | 'monthly', ScrapedWindow>> {
  const result: Partial<Record<'rolling' | 'weekly' | 'monthly', ScrapedWindow>> = {}
  const items = html.split(/data-slot="usage-item"/)
  for (let i = 1; i < items.length; i++) {
    const content = items[i]
    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</)
    if (!labelMatch) continue
    const label = labelMatch[1].trim().toLowerCase()
    const usageMatch = content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/)
    if (!usageMatch) continue
    const usagePercent = Number(usageMatch[1])
    const resetMatch = content.match(/data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/)
    if (!resetMatch) continue
    const resetContent = resetMatch[2]
      .replace(/<!--\$-->/g, '')
      .replace(/<!--\/-->/g, '')
      .replace(/Resets?\s*in\s*/i, '')
      .trim()
    const resetInSec = resetMatch[1] === 'reset-now' ? 0 : parseHumanTime(resetContent)
    if (!Number.isFinite(usagePercent) || resetInSec === null || !Number.isFinite(resetInSec)) continue
    const key: 'rolling' | 'weekly' | 'monthly' | null =
      label.includes('rolling') ? 'rolling'
      : label.includes('weekly') ? 'weekly'
      : label.includes('monthly') ? 'monthly'
      : null
    if (key) result[key] = { usagePercent, resetInSec }
  }
  return result
}

function normalizeWindow(window: ScrapedWindow, now: number): OpenCodeGoWindow {
  const usagePercent = Math.max(0, window.usagePercent)
  const resetInSec = Math.max(0, window.resetInSec)
  return {
    usagePercent,
    resetInSec,
    percentRemaining: 100 - usagePercent,
    resetTimeIso: new Date(now + resetInSec * 1000).toISOString(),
  }
}

export interface OpenCodeGoUsageCredentials {
  workspaceId: string
  authCookie: string
}

export async function queryOpenCodeGoUsage(
  creds: OpenCodeGoUsageCredentials,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeGoUsageResult> {
  const now = Date.now()
  const base: OpenCodeGoUsageResult = { success: false, configured: true, fetchedAt: now }
  if (!creds.workspaceId || !creds.authCookie) {
    return { ...base, configured: false, error: 'OpenCode Go workspace ID and auth cookie are not configured' }
  }
  const url = `${DASHBOARD_URL_PREFIX}${encodeURIComponent(creds.workspaceId)}${DASHBOARD_URL_SUFFIX}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        Cookie: `auth=${creds.authCookie}`,
      },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SCRAPE_TIMEOUT_MS),
    })
    if (!res.ok) {
      const cookieExpired = res.status === 401 || res.status === 403 || res.status === 302 || res.status === 303
      return { ...base, cookieExpired, error: `OpenCode Go dashboard returned HTTP ${res.status}` }
    }
    const html = await res.text()

    let rolling = parseSolidWindow(html, RE.rolling)
    let weekly = parseSolidWindow(html, RE.weekly)
    let monthly = parseSolidWindow(html, RE.monthly)

    if (!rolling && !weekly && !monthly) {
      const ds = parseDataSlot(html)
      rolling = ds.rolling ?? null
      weekly = ds.weekly ?? null
      monthly = ds.monthly ?? null
    }

    if (!rolling && !weekly && !monthly) {
      // A 2xx with no usage windows is the login-redirect signature: the
      // auth cookie is expired/invalid and the server returned the login
      // page instead of the workspace dashboard.
      return { ...base, cookieExpired: true, error: 'Auth cookie is expired or invalid — renew it in the account settings' }
    }

    return {
      ...base,
      success: true,
      ...(rolling ? { rolling: normalizeWindow(rolling, now) } : {}),
      ...(weekly ? { weekly: normalizeWindow(weekly, now) } : {}),
      ...(monthly ? { monthly: normalizeWindow(monthly, now) } : {}),
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}