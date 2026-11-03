export interface MockRemote {
  url: string
  port: number
  stats: { registrations: number; authorizes: number; tokens: number; refreshes: number; mcp: number }
  expireTokens(): void
  close(): Promise<void>
}
export function startMockRemote(opts?: { port?: number; mode?: 'open' | 'bearer' | 'oauth' | 'sse'; bearer?: string }): Promise<MockRemote>
