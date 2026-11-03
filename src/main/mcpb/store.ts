import { getMcpConfigForManifest, hasRequiredConfigMissing, replaceVariables } from '@anthropic-ai/mcpb/browser'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join, sep } from 'node:path'
import type { ExtensionPreview, ExtensionResult, InstalledExtension, McpServerConfig, UserConfigValue } from '../../shared/types'
import type { SecretVault } from '../vault'
import { BundleError, cleanStaging, iconDataUrl, idFromName, installFiles, normalizeUserConfig, parseBundle, type Manifest, type ParsedBundle } from './bundle'

interface StoredState {
  version: 1
  items: Record<string, { enabled: boolean; values: Record<string, UserConfigValue>; installedAt: number; signed?: boolean }>
}

export interface StoreEnv {
  /** Values for ${HOME}, ${DESKTOP}, ${DOCUMENTS}, ${DOWNLOADS}. */
  systemDirs: () => Record<string, string>
  platform?: string
  /** Path of the running executable; used to run `node` servers when no node is installed (ELECTRON_RUN_AS_NODE). */
  execPath?: string
  hasCommand?: (cmd: string) => boolean
  pathExists?: (p: string, kind: 'file' | 'directory') => boolean
}

export function commandOnPath(cmd: string, pathVar = process.env.PATH ?? '', platform = process.platform): boolean {
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    for (const e of exts) if (existsSync(join(dir, cmd + e.toLowerCase())) || existsSync(join(dir, cmd + e))) return true
  }
  return false
}

const defaultPathExists = (p: string, kind: 'file' | 'directory'): boolean => {
  try {
    const s = statSync(p)
    return kind === 'directory' ? s.isDirectory() : s.isFile()
  } catch {
    return false
  }
}

export class ExtensionStore {
  private staged = new Map<string, { parsed: ParsedBundle; at: number }>()
  onChange?: () => void

  constructor(
    private root: string,
    private vault: SecretVault,
    private env: StoreEnv
  ) {
    mkdirSync(root, { recursive: true })
    cleanStaging(root)
  }

  private get stateFile(): string {
    return join(this.root, 'extensions.json')
  }
  private load(): StoredState {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StoredState
      if (s?.items) return s
    } catch {
      /* none yet */
    }
    return { version: 1, items: {} }
  }
  private save(s: StoredState): void {
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, this.stateFile)
  }
  private manifestOf(id: string): Manifest | undefined {
    try {
      return JSON.parse(readFileSync(join(this.root, id, 'manifest.json'), 'utf8')) as Manifest
    } catch {
      return undefined
    }
  }
  private async secrets(id: string): Promise<Record<string, UserConfigValue>> {
    return (await this.vault.get<Record<string, UserConfigValue>>(`ext:${id}`)) ?? {}
  }
  private pathExists(): (p: string, k: 'file' | 'directory') => boolean {
    return this.env.pathExists ?? defaultPathExists
  }

  resolveDefaults(manifest: Manifest): Record<string, UserConfigValue> {
    const out: Record<string, UserConfigValue> = {}
    const dirs = { ...this.env.systemDirs(), pathSeparator: sep, '/': sep }
    for (const [k, f] of Object.entries(manifest.user_config ?? {})) {
      if (f.default !== undefined) out[k] = replaceVariables(f.default, dirs) as UserConfigValue
    }
    return out
  }

  // ---- preview / install ----

  async preview(bytes: Uint8Array): Promise<ExtensionPreview> {
    for (const [k, v] of this.staged) if (Date.now() - v.at > 10 * 60_000) this.staged.delete(k)
    const parsed = parseBundle(bytes, this.env.platform)
    const m = parsed.manifest
    const id = idFromName(m.name)
    const stagingId = randomUUID()
    this.staged.set(stagingId, { parsed, at: Date.now() })
    while (this.staged.size > 3) this.staged.delete(this.staged.keys().next().value as string)
    const state = this.load().items[id]
    const prevManifest = state ? this.manifestOf(id) : undefined
    const secretKeys = Object.keys(await this.secrets(id))
    return {
      stagingId,
      id,
      name: m.name,
      displayName: m.display_name || m.name,
      version: m.version,
      description: m.description,
      author: m.author?.name ?? '',
      serverType: m.server.type,
      command: m.server.mcp_config.command,
      args: m.server.mcp_config.args ?? [],
      tools: (m.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      userConfig: m.user_config ?? {},
      defaults: this.resolveDefaults(m),
      signed: parsed.signed,
      warnings: parsed.warnings,
      fileCount: parsed.files.size,
      sizeBytes: parsed.sizeBytes,
      icon: iconDataUrl(m, parsed.files),
      previous: state && prevManifest ? { version: prevManifest.version, values: state.values, secretKeys } : undefined
    }
  }

  discard(stagingId: string): void {
    this.staged.delete(stagingId)
  }

  async install(stagingId: string, raw: Record<string, unknown>): Promise<ExtensionResult> {
    const entry = this.staged.get(stagingId)
    if (!entry) return { ok: false, error: 'This install session expired. Choose the file again.' }
    const { parsed } = entry
    const m = parsed.manifest
    const id = idFromName(m.name)
    const state = this.load()
    const prev = state.items[id]
    const prevSecrets = await this.secrets(id)
    const fields = m.user_config ?? {}
    // Start from defaults, then previous values, then what the user entered.
    const merged: Record<string, unknown> = { ...this.resolveDefaults(m), ...(prev?.values ?? {}), ...raw }
    const { values, errors } = normalizeUserConfig(fields, merged, { keepSecret: Object.keys(prevSecrets), pathExists: this.pathExists() })
    if (Object.keys(errors).length) return { ok: false, error: 'Some settings are invalid.', fieldErrors: errors }
    try {
      installFiles(parsed, this.root, id)
    } catch (e) {
      return { ok: false, error: e instanceof BundleError ? e.message : `Install failed: ${(e as Error).message}` }
    }
    await this.persistValues(id, m, values, prevSecrets, prev?.enabled ?? true, prev?.installedAt, parsed.signed)
    this.staged.delete(stagingId)
    this.onChange?.()
    return { ok: true, extension: (await this.describe(id))! }
  }

  private async persistValues(id: string, m: Manifest, values: Record<string, UserConfigValue>, prevSecrets: Record<string, UserConfigValue>, enabled: boolean, installedAt?: number, signed?: boolean): Promise<void> {
    const fields = m.user_config ?? {}
    const plain: Record<string, UserConfigValue> = {}
    const secret: Record<string, UserConfigValue> = {}
    for (const [k, f] of Object.entries(fields)) {
      if (f.sensitive) {
        const v = values[k] ?? prevSecrets[k]
        if (v !== undefined) secret[k] = v
      } else if (values[k] !== undefined) plain[k] = values[k]!
    }
    if (Object.keys(secret).length) await this.vault.set(`ext:${id}`, secret)
    else await this.vault.delete(`ext:${id}`)
    const state = this.load()
    state.items[id] = { enabled, values: plain, installedAt: installedAt ?? Date.now(), signed: signed ?? state.items[id]?.signed }
    this.save(state)
  }

  // ---- queries / changes ----

  private async effectiveValues(id: string, m: Manifest): Promise<Record<string, UserConfigValue>> {
    const stored = this.load().items[id]
    return { ...this.resolveDefaults(m), ...(stored?.values ?? {}), ...(await this.secrets(id)) }
  }

  async describe(id: string): Promise<InstalledExtension | undefined> {
    const stored = this.load().items[id]
    const m = this.manifestOf(id)
    if (!stored || !m) return undefined
    const fields = m.user_config ?? {}
    const all = await this.effectiveValues(id, m)
    const secretKeys = Object.keys(fields).filter((k) => fields[k]!.sensitive && all[k] !== undefined)
    const values: Record<string, UserConfigValue> = {}
    for (const [k, v] of Object.entries(all)) if (!fields[k]?.sensitive) values[k] = v
    const missingRequired = Object.entries(fields)
      .filter(([k, f]) => f.required && (all[k] === undefined || all[k] === '' || (Array.isArray(all[k]) && (all[k] as unknown[]).length === 0)))
      .map(([k]) => k)
    let icon: string | undefined
    try {
      if (m.icon && !/^[a-z]+:/i.test(m.icon)) {
        const data = readFileSync(join(this.root, id, m.icon.replace(/^\.\//, '')))
        icon = iconDataUrl(m, new Map([[m.icon.replace(/^\.\//, ''), data]]))
      }
    } catch {
      /* no icon */
    }
    return {
      id,
      name: m.name,
      displayName: m.display_name || m.name,
      version: m.version,
      description: m.description,
      author: m.author?.name ?? '',
      serverType: m.server.type,
      enabled: stored.enabled,
      userConfig: fields,
      values,
      secretKeys,
      missingRequired,
      signed: !!stored.signed,
      installedAt: stored.installedAt,
      icon
    }
  }

  async list(): Promise<InstalledExtension[]> {
    const items = Object.keys(this.load().items)
    const described = await Promise.all(items.map((id) => this.describe(id)))
    return described
      .filter((x): x is InstalledExtension => !!x)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  setEnabled(id: string, enabled: boolean): void {
    const s = this.load()
    if (!s.items[id]) return
    s.items[id]!.enabled = enabled
    this.save(s)
    this.onChange?.()
  }

  async configure(id: string, raw: Record<string, unknown>): Promise<ExtensionResult> {
    const m = this.manifestOf(id)
    const s = this.load()
    if (!m || !s.items[id]) return { ok: false, error: 'Extension not found' }
    const prevSecrets = await this.secrets(id)
    const merged = { ...this.resolveDefaults(m), ...s.items[id]!.values, ...raw }
    const { values, errors } = normalizeUserConfig(m.user_config ?? {}, merged, { keepSecret: Object.keys(prevSecrets), pathExists: this.pathExists() })
    if (Object.keys(errors).length) return { ok: false, error: 'Some settings are invalid.', fieldErrors: errors }
    await this.persistValues(id, m, values, prevSecrets, s.items[id]!.enabled, s.items[id]!.installedAt)
    this.onChange?.()
    return { ok: true, extension: (await this.describe(id))! }
  }

  async uninstall(id: string): Promise<void> {
    const s = this.load()
    delete s.items[id]
    this.save(s)
    await this.vault.delete(`ext:${id}`)
    if (/^[a-z0-9][a-z0-9._-]*$/.test(id)) rmSync(join(this.root, id), { recursive: true, force: true })
    this.onChange?.()
  }

  /** MCP server configs for all enabled extensions whose required settings are filled in. */
  async servers(): Promise<McpServerConfig[]> {
    const out: McpServerConfig[] = []
    const has = this.env.hasCommand ?? ((c: string) => commandOnPath(c))
    for (const [id, st] of Object.entries(this.load().items)) {
      const m = this.manifestOf(id)
      if (!m) continue
      const dir = join(this.root, id)
      const userConfig = await this.effectiveValues(id, m)
      if (hasRequiredConfigMissing({ manifest: m as never, userConfig })) {
        // Shown in the UI as "needs setup"; still listed so the user sees why it is not running.
        out.push({ id: `ext:${id}`, name: m.name, enabled: false, command: '', args: [], env: {}, extensionId: id })
        continue
      }
      const cfg = (await getMcpConfigForManifest({ manifest: m as never, extensionPath: dir, systemDirs: this.env.systemDirs(), userConfig, pathSeparator: sep })) as { command: string; args?: string[]; env?: Record<string, string> } | undefined
      if (!cfg) continue
      let { command } = cfg
      const env = { ...(cfg.env ?? {}) }
      if (command === 'node' && !has('node') && this.env.execPath) {
        command = this.env.execPath
        env.ELECTRON_RUN_AS_NODE = '1'
      } else if (command === 'python' && !has('python') && has('python3')) command = 'python3'
      out.push({ id: `ext:${id}`, name: m.name, enabled: st.enabled, command, args: cfg.args ?? [], env, cwd: dir, extensionId: id })
    }
    return out
  }
}
