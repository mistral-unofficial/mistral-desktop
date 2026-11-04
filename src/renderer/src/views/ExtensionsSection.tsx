import { type DragEvent, useEffect, useState } from 'react'
import type { ExtensionPreview, InstalledExtension, McpServerStatus, UserConfigField, UserConfigValue } from '@shared/types'
import { Collapsible } from '../components'
import { type FormValues, describeCommand, initialFormValues, placeholderFor } from '../configForm'

function ConfigForm({ fields, values, onChange, errors, secretKeys }: { fields: Record<string, UserConfigField>; values: FormValues; onChange: (v: FormValues) => void; errors?: Record<string, string>; secretKeys: string[] }) {
  const set = (k: string, v: string | boolean): void => onChange({ ...values, [k]: v })
  const browse = async (k: string, f: UserConfigField): Promise<void> => {
    const p = await window.api.dialog.pickPath(f.type === 'directory' ? 'directory' : 'file')
    if (!p) return
    const cur = String(values[k] ?? '')
    set(k, f.multiple && cur ? `${cur}\n${p}` : p)
  }
  return (
    <div className="configform">
      {Object.entries(fields).map(([k, f]) => {
        const id = `cfg-${k}`
        const err = errors?.[k]
        return (
          <div key={k} className="field">
            <label htmlFor={id}>{f.title}{f.required && <span aria-label="required"> *</span>}</label>
            {f.description && <span className="muted">{f.description}</span>}
            {f.type === 'boolean' ? (
              <label className="check"><input id={id} type="checkbox" checked={!!values[k]} onChange={(e) => set(k, e.target.checked)} /> Enabled</label>
            ) : f.multiple ? (
              <textarea id={id} rows={3} value={String(values[k] ?? '')} placeholder={placeholderFor(f, secretKeys.includes(k))} onChange={(e) => set(k, e.target.value)} />
            ) : (
              <input id={id} type={f.sensitive ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete="off" min={f.min} max={f.max} value={String(values[k] ?? '')} placeholder={placeholderFor(f, secretKeys.includes(k))} onChange={(e) => set(k, e.target.value)} />
            )}
            {(f.type === 'directory' || f.type === 'file') && <div className="row"><button type="button" onClick={() => void browse(k, f)}>Browse…</button></div>}
            {err && <span className="warnline" role="alert">{err}</span>}
          </div>
        )
      })}
    </div>
  )
}

function InstallDialog({ preview, onClose }: { preview: ExtensionPreview; onClose: (installed: boolean) => void }) {
  const [values, setValues] = useState<FormValues>(() => initialFormValues(preview.userConfig, { ...preview.defaults, ...(preview.previous?.values ?? {}) }))
  const [errors, setErrors] = useState<Record<string, string>>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const secretKeys = preview.previous?.secretKeys ?? []

  const cancel = (): void => {
    void window.api.extensions.discard(preview.stagingId)
    onClose(false)
  }
  const install = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await window.api.extensions.install(preview.stagingId, values as Record<string, UserConfigValue | string>)
    setBusy(false)
    if (r.ok) return onClose(true)
    setError(r.error)
    setErrors(r.fieldErrors)
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal install" role="dialog" aria-modal="true" aria-label={`Install ${preview.displayName}`}>
        <header className="install-head">
          {preview.icon && <img src={preview.icon} alt="" width={40} height={40} />}
          <div>
            <h3>{preview.displayName} <span className="muted">v{preview.version}</span></h3>
            <span className="muted">{preview.author ? `by ${preview.author}` : 'Unknown author'}</span>
          </div>
        </header>
        <div className="install-body">
          {preview.description && <p>{preview.description}</p>}
          {preview.previous && <p className="muted">Updating from v{preview.previous.version}. Your settings are kept.</p>}
          {Object.keys(preview.userConfig).length > 0 && (
            <>
              <h4>Settings</h4>
              <p className="muted">These values are passed to the extension (as environment variables / arguments, as defined by its manifest).</p>
              <ConfigForm fields={preview.userConfig} values={values} onChange={(v) => { setValues(v); setErrors(undefined); setError('') }} errors={errors} secretKeys={secretKeys} />
            </>
          )}
          <div className="notice">
            <strong>This extension runs code on your computer</strong> with your user's permissions, so it can read your files and use the network.
            {' '}Only install extensions from people you trust.
            <div className="muted">{preview.signed ? 'The bundle contains a signature, but this app does not verify it.' : 'The bundle is not signed.'}</div>
          </div>
          <div className="muted">Will run: <code>{describeCommand(preview.command, preview.args)}</code> ({preview.serverType})</div>
          {preview.warnings.map((w) => <div key={w} className="muted">• {w}</div>)}
          {preview.tools.length > 0 && <Collapsible summary={`${preview.tools.length} tool${preview.tools.length === 1 ? '' : 's'}`}><ul>{preview.tools.map((t) => <li key={t.name}><strong>{t.name}</strong>{t.description ? <span className="muted"> {t.description}</span> : null}</li>)}</ul></Collapsible>}
        </div>
        <footer className="install-foot">
          {error && <div className="warnline" role="alert">{error}</div>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void install()}>{preview.previous ? 'Update' : 'Install'}</button>
            <button disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function ExtensionCard({ ext, status }: { ext: InstalledExtension; status?: McpServerStatus }) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<Record<string, string>>()
  const [confirm, setConfirm] = useState(false)
  const needsSetup = ext.missingRequired.length > 0
  const badge = needsSetup ? 'needs setup' : !ext.enabled ? 'disabled' : status?.state ?? 'starting'
  const hasFields = Object.keys(ext.userConfig).length > 0

  const open = (): void => {
    setValues(initialFormValues(ext.userConfig, ext.values))
    setErrors(undefined)
    setEditing(true)
  }
  const save = async (): Promise<void> => {
    const r = await window.api.extensions.configure(ext.id, values as Record<string, UserConfigValue | string>)
    if (r.ok) setEditing(false)
    else setErrors(r.fieldErrors ?? { _: r.error })
  }
  return (
    <div className="mcpcard" data-testid={`ext-${ext.id}`}>
      <div className="row" style={{ marginTop: 0 }}>
        {ext.icon && <img src={ext.icon} alt="" width={28} height={28} />}
        <strong>{ext.displayName}</strong> <span className="muted">v{ext.version}</span>
        <span className={`badge ${badge.replace(' ', '-')}`}>{badge}</span>
        <label className="check" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={ext.enabled} disabled={needsSetup} onChange={(e) => void window.api.extensions.setEnabled(ext.id, e.target.checked)} /> Enabled</label>
      </div>
      <div className="muted">{ext.description}</div>
      {status?.error && <div className="warnline">{status.error}</div>}
      {status?.state === 'connected' && <div className="muted">Tools: {status.tools.join(', ') || 'none'}</div>}
      {needsSetup && <div className="warnline">Needs setup: {ext.missingRequired.map((k) => ext.userConfig[k]?.title ?? k).join(', ')}</div>}
      {editing ? (
        <>
          <ConfigForm fields={ext.userConfig} values={values} onChange={(v) => { setValues(v); setErrors(undefined) }} errors={errors} secretKeys={ext.secretKeys} />
          {errors?._ && <div className="warnline" role="alert">{errors._}</div>}
          <div className="row"><button className="primary" onClick={() => void save()}>Save</button><button onClick={() => setEditing(false)}>Cancel</button></div>
        </>
      ) : (
        <div className="row">
          {hasFields && <button onClick={open}>{needsSetup ? 'Set up…' : 'Settings…'}</button>}
          {confirm ? (
            <>
              <span>Remove this extension and its settings?</span>
              <button className="danger" onClick={() => void window.api.extensions.uninstall(ext.id)}>Remove</button>
              <button onClick={() => setConfirm(false)}>Keep</button>
            </>
          ) : (
            <button onClick={() => setConfirm(true)}>Uninstall</button>
          )}
        </div>
      )}
    </div>
  )
}

export function ExtensionsSection({ status }: { status: McpServerStatus[] }) {
  const [list, setList] = useState<InstalledExtension[]>([])
  const [preview, setPreview] = useState<ExtensionPreview>()
  const [error, setError] = useState('')
  const [over, setOver] = useState(false)

  useEffect(() => {
    void window.api.extensions.list().then(setList)
    return window.api.extensions.onChange(setList)
  }, [])

  const show = (r: ExtensionPreview | { error: string } | undefined): void => {
    if (!r) return
    if ('error' in r) setError(r.error)
    else {
      setError('')
      setPreview(r)
    }
  }
  const onDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files[0]
    if (f) show(await window.api.extensions.previewFile(f))
  }
  return (
    <section>
      <h3>Extensions (.mcpb)</h3>
      <p className="muted">Install MCP bundles (<code>.mcpb</code>, formerly <code>.dxt</code>): one-click local servers with their own settings. They are available in Chat and Code.</p>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <button className="primary" onClick={() => void window.api.extensions.pick().then(show)}>Install extension…</button>
        <span className="muted">or drop a .mcpb file here</span>
      </div>
      {error && <p className="warnline" role="alert">{error}</p>}
      {list.map((x) => <ExtensionCard key={x.id} ext={x} status={status.find((s) => s.extensionId === x.id)} />)}
      {!list.length && <p className="muted">No extensions installed.</p>}
      {preview && <InstallDialog preview={preview} onClose={() => setPreview(undefined)} />}
    </section>
  )
}
