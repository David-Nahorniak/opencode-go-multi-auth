export function generateProviderConfig(proxyPort: number, proxyAccessToken?: string): Record<string, unknown> {
  const options: Record<string, unknown> = { baseURL: `http://localhost:${proxyPort}` }
  if (proxyAccessToken) options.apiKey = proxyAccessToken
  return {
    'opencode-go': { options },
  }
}

export function printSetupInstructions(proxyPort: number, dashboardPort: number, proxyAccessToken = ''): void {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         OpenCode Go Router — Setup Guide            ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  1. Add this to ~/.opencode/opencode.json:          ║
║                                                      ║
║     {                                                ║
║       "provider": {                                  ║
║         "opencode-go": {                             ║
║           "options": {                               ║
║             "baseURL": "http://localhost:${proxyPort}",  ║
║             "apiKey": "<PROXY_ACCESS_TOKEN>"         ║
║           }                                          ║
║         },                                           ║
║         "multi-auth-zen": {                          ║
║           "npm": "@ai-sdk/openai-compatible",         ║
║           "name": "OpenCode Zen (multi-auth)",        ║
║           "options": {                               ║
║             "baseURL": "http://localhost:${proxyPort}/zen", ║
║             "apiKey": "<PROXY_ACCESS_TOKEN>"         ║
║           },                                         ║
║           "models": {                                 ║
║             "deepseek-v4-flash-free": {},            ║
║             "mimo-v2.5-free": {}                     ║
║           }                                          ║
║         }                                            ║
║       }                                              ║
║     }                                                ║
║                                                      ║
║  2. Proxy access token (required on every request):  ║
║     ${proxyAccessToken || '(generated on first boot)'}                ║
║     → opencode sends it as the provider "apiKey".    ║
║       The proxy strips it and injects the pooled     ║
║       upstream key. A new token can be regenerated    ║
║       in the dashboard → Settings.                    ║
║                                                      ║
║  3. Dashboard is available at:                       ║
║     http://localhost:${dashboardPort}                    ║
║                                                      ║
║  4. Add your Go API keys via the Dashboard.          ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`)
}