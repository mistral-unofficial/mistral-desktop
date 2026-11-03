import { MANIFEST_SCHEMAS_LOOSE } from '@anthropic-ai/mcpb/browser'
import { unzipSync } from 'fflate'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { UserConfigField, UserConfigValue } from '../../shared/types'

export const LIMITS = { archiveBytes: 150 * 1024 * 1024, unpackedBytes: 600 * 1024 * 1024, files: 20_000 }

export class BundleError extends Error {}

/** The subset of the manifest this app reads. The full manifest is validated by the official schema. */
export interface Manifest {
  manifest_version?: string
  dxt_version?: string
  name: string
  display_name?: string
  version: string
  description: string
  author: { name: string } & Record<string, unknown>
  icon?: string
  server: {
    type: 'node' | 'python' | 'binary' | 'uv'
    entry_point: string
    mcp_config: { command: string; args?: string[]; env?: Record<string, string>; platform_overrides?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> }
  }
  tools?: { name: string; description?: string }[]
  user_config?: Record<string, UserConfigField>
  compatibility?: { platforms?: string[]; runtimes?: Record<string, string> }
}

export interface ParsedBundle {
  manifest: Manifest
  files: Map<string, Uint8Array>
  signed: boolean
  warnings: string[]
  sizeBytes: number
}

const SIG_HEADER = Buffer.from('MCPB_SIG_V1')
const SIG_FOOTER = Buffer.from('MCPB_SIG_END')

/** Signed bundles are a zip followed by a signature block; return the zip part. The signature is not verified. */
export function stripSignature(buf: Uint8Array): { zip: Uint8Array; signed: boolean } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const footer = b.lastIndexOf(SIG_FOOTER)
  if (footer === -1) return { zip: buf, signed: false }
  const header = b.lastIndexOf(SIG_HEADER, footer)
  if (header === -1) return { zip: buf, signed: false }
  return { zip: buf.subarray(0, header), signed: true }
}

/** Reject zip-slip and other unsafe member names. Returns the normalised name, '' for entries to skip. */
export function safeEntryName(name: string): string {
  if (name.includes('\0') || name.includes('\\')) throw new BundleError(`Unsafe file name in bundle: ${JSON.stringify(name)}`)
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new BundleError(`Absolute path in bundle: ${name}`)
  const parts = name.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new BundleError(`Path traversal in bundle: ${name}`)
  if (name.endsWith('/')) return '' // directory entry
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') return ''
  return parts.join('/')
}

export function idFromName(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
  if (!id || id === '.' || id === '..') throw new BundleError(`Cannot derive an install id from the name "${name}"`)
  return id
}

const normPath = (p: string): string => p.replace(/^\.\//, '').replace(/\\/g, '/')

export function parseBundle(input: Uint8Array, platform: string = process.platform): ParsedBundle {
  if (input.byteLength > LIMITS.archiveBytes) throw new BundleError('Bundle is larger than 150 MB')
  const { zip, signed } = stripSignature(input)
  const files = new Map<string, Uint8Array>()
  let count = 0
  let total = 0
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(zip, {
      filter: (f) => {
        const name = safeEntryName(f.name)
        if (!name) return false
        if (++count > LIMITS.files) throw new BundleError('Bundle has too many files')
        total += f.originalSize
        if (total > LIMITS.unpackedBytes) throw new BundleError('Bundle is too large when unpacked (limit 600 MB)')
        return true
      }
    })
  } catch (e) {
    if (e instanceof BundleError) throw e
    throw new BundleError('This is not a valid .mcpb file (could not read it as a zip archive)')
  }
  for (const [n, data] of Object.entries(unzipped)) {
    const name = safeEntryName(n)
    if (name) files.set(name, data)
  }

  const mf = files.get('manifest.json')
  if (!mf) throw new BundleError('manifest.json is missing from the bundle')
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(mf).toString('utf8').replace(/^﻿/, '')) as Record<string, unknown>
  } catch {
    throw new BundleError('manifest.json is not valid JSON')
  }
  const version = String(raw.manifest_version ?? raw.dxt_version ?? '')
  const schema = (MANIFEST_SCHEMAS_LOOSE as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } }>)[version]
  if (!schema) throw new BundleError(`Unsupported or missing manifest_version "${version}" (supported: ${Object.keys(MANIFEST_SCHEMAS_LOOSE).join(', ')})`)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? []).slice(0, 5).map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`)
    throw new BundleError(`Invalid manifest: ${issues.join('; ')}`)
  }
  const manifest = parsed.data as Manifest

  idFromName(manifest.name)
  const warnings: string[] = []
  const platforms = manifest.compatibility?.platforms
  if (platforms?.length && !platforms.includes(platform)) {
    throw new BundleError(`This extension does not support your operating system (it supports: ${platforms.join(', ')})`)
  }
  const entry = normPath(manifest.server.entry_point)
  if (!files.has(entry)) {
    const msg = `Entry point "${manifest.server.entry_point}" is not in the bundle`
    if (manifest.server.type === 'uv') warnings.push(msg)
    else throw new BundleError(msg)
  }
  const rt = manifest.compatibility?.runtimes
  if (rt) warnings.push(`Requires ${Object.entries(rt).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (manifest.server.type === 'python' || manifest.server.type === 'uv') warnings.push('Needs Python (or uv) installed on this computer.')

  return { manifest, files, signed, warnings, sizeBytes: total }
}

/** Icon as a data URL when it is a small PNG inside the bundle. */
export function iconDataUrl(manifest: Manifest, files: Map<string, Uint8Array>): string | undefined {
  if (!manifest.icon || /^[a-z]+:/i.test(manifest.icon)) return undefined
  const data = files.get(normPath(manifest.icon))
  if (!data || data.byteLength > 256 * 1024 || data[0] !== 0x89 || data[1] !== 0x50) return undefined
  return `data:image/png;base64,${Buffer.from(data).toString('base64')}`
}

/**
 * Write the bundle to <root>/<id>. Files go to a staging directory first and are swapped in, so a
 * failed install never leaves a half-written extension (and an update keeps the old one on failure).
 */
export function installFiles(parsed: ParsedBundle, root: string, id: string): string {
  const dest = join(root, id)
  const staging = join(root, `.staging-${id}-${process.pid}-${Date.now()}`)
  const base = resolve(staging) + sep
  mkdirSync(staging, { recursive: true })
  try {
    for (const [name, data] of parsed.files) {
      const target = resolve(staging, name)
      if (!target.startsWith(base)) throw new BundleError(`Unsafe path in bundle: ${name}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data, { mode: 0o644 })
    }
    if (process.platform !== 'win32' && parsed.manifest.server.type === 'binary') {
      const entry = resolve(staging, normPath(parsed.manifest.server.entry_point))
      if (entry.startsWith(base) && existsSync(entry)) chmodSync(entry, 0o755)
    }
    const old = `${dest}.old-${Date.now()}`
    if (existsSync(dest)) renameSync(dest, old)
    try {
      renameSync(staging, dest)
    } catch (e) {
      if (existsSync(old)) renameSync(old, dest)
      throw e
    }
    if (existsSync(old)) rmSync(old, { recursive: true, force: true })
    return dest
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    throw e
  }
}

export function cleanStaging(root: string): void {
  if (!existsSync(root)) return
  for (const n of readdirSync(root)) if (n.startsWith('.staging-') || n.includes('.old-')) rmSync(join(root, n), { recursive: true, force: true })
}

// ---- user_config ----

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * Coerce and validate user-supplied values against the manifest's user_config.
 * `keepSecret` lists sensitive keys that already have a stored value (an empty input then means "unchanged").
 */
export function normalizeUserConfig(
  fields: Record<string, UserConfigField>,
  raw: Record<string, unknown>,
  opts: { keepSecret?: string[]; pathExists?: (p: string, kind: 'file' | 'directory') => boolean } = {}
): { values: Record<string, UserConfigValue>; errors: Record<string, string> } {
  const values: Record<string, UserConfigValue> = {}
  const errors: Record<string, string> = {}
  for (const [key, f] of Object.entries(fields)) {
    let v = raw[key]
    if (isEmpty(v) && f.sensitive && opts.keepSecret?.includes(key)) continue
    if (isEmpty(v)) {
      if (f.required) errors[key] = 'Required'
      continue
    }
    const list = f.multiple ? (Array.isArray(v) ? v : String(v).split('\n')).map((x) => String(x).trim()).filter(Boolean) : undefined
    if (f.multiple && f.type !== 'number' && f.type !== 'boolean') {
      if (!list!.length) {
        if (f.required) errors[key] = 'Required'
        continue
      }
      v = list
    }
    switch (f.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).trim())
        if (!Number.isFinite(n)) errors[key] = 'Must be a number'
        else if (f.min !== undefined && n < f.min) errors[key] = `Must be at least ${f.min}`
        else if (f.max !== undefined && n > f.max) errors[key] = `Must be at most ${f.max}`
        else values[key] = n
        break
      }
      case 'boolean':
        if (typeof v === 'boolean') values[key] = v
        else if (v === 'true' || v === 'false') values[key] = v === 'true'
        else errors[key] = 'Must be true or false'
        break
      case 'directory':
      case 'file': {
        const items = Array.isArray(v) ? (v as string[]) : [String(v)]
        const bad = items.find((p) => !p || (opts.pathExists && !opts.pathExists(p, f.type as 'file' | 'directory')))
        if (bad !== undefined) errors[key] = f.type === 'directory' ? `Folder not found: ${bad}` : `File not found: ${bad}`
        else values[key] = Array.isArray(v) ? (v as string[]) : String(v)
        break
      }
      default:
        values[key] = Array.isArray(v) ? (v as string[]) : String(v)
    }
  }
  return { values, errors }
}
