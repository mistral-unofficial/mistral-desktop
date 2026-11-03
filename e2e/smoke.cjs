// End-to-end smoke test: drives the real Electron app with Playwright.
// Needs: npm run build; vibe-acp installed (VIBE_ACP=/path/to/vibe-acp); Playwright available.
// Run under a display, e.g.: xvfb-run -a node e2e/smoke.cjs
const { _electron: electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { zipSync, strToU8 } = require('fflate')

const root = path.resolve(__dirname, '..')
const VIBE_ACP = process.env.VIBE_ACP
if (!VIBE_ACP) throw new Error('Set VIBE_ACP to the vibe-acp executable')
const shots = process.env.SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'md-shots-'))
fs.mkdirSync(shots, { recursive: true })

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'md-data-'))
const vhome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vhome-'))
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'md-proj-'))
fs.copyFileSync(path.join(__dirname, 'vibe-mock-config.toml'), path.join(vhome, 'config.toml'))
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ apiBase: 'http://127.0.0.1:8798/v1', model: 'mock-large', vibePath: VIBE_ACP, vibeHome: vhome }))

// A real .mcpb bundle: manifest + the test MCP server, with a sensitive required setting.
const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-bundle-')), 'demo.mcpb')
fs.writeFileSync(bundlePath, zipSync({
  'manifest.json': strToU8(JSON.stringify({
    manifest_version: '0.2', name: 'bundled-demo', display_name: 'Bundled Demo', version: '1.2.3', description: 'Demo bundle for e2e', author: { name: 'E2E' },
    server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { GREETING: '${user_config.greeting}', SECRET: '${user_config.api_key}' } } },
    tools: [{ name: 'info', description: 'Report config' }],
    user_config: { greeting: { type: 'string', title: 'Greeting', description: 'What to say', default: 'hello' }, api_key: { type: 'string', title: 'API key', description: 'Secret key', sensitive: true, required: true } }
  })),
  'server/index.js': fs.readFileSync(path.join(root, 'tests/fixtures/mcpb-server.mjs'))
}))

const servers = [
  spawn(process.execPath, [path.join(__dirname, 'mock-remote-mcp.mjs')], { stdio: 'inherit', env: { ...process.env, MOCK_REMOTE_MODE: 'oauth', MOCK_REMOTE_PORT: '8797' } }),
  spawn(process.execPath, [path.join(__dirname, 'mock-mistral.mjs')], { stdio: 'inherit' }),
  spawn(process.execPath, [path.join(__dirname, 'mock-vibe-llm.mjs')], { stdio: 'inherit' })
]
const cleanup = () => servers.forEach((s) => s.kill())

;(async () => {
  await new Promise((r) => setTimeout(r, 800))
  const app = await electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: [root, '--no-sandbox'],
    env: { ...process.env, MISTRAL_DESKTOP_DATA: data, MISTRAL_DESKTOP_TEST_FOLDER: project, MISTRAL_DESKTOP_TEST_MCPB: bundlePath, MISTRAL_DESKTOP_TEST_BROWSER: 'fetch', MOCK_KEY: 'x', MISTRAL_API_KEY: '' }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))
  page.on('console', (m) => m.type() === 'error' && console.error('[console.error]', m.text()))
  await page.setViewportSize({ width: 1100, height: 760 })
  const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') })
  const step = (s) => console.log('•', s)

  step('chat without key shows the banner and a clear error')
  await page.getByText('No Mistral API key yet').waitFor()
  await page.getByPlaceholder(/Message Mistral/).fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText(/No API key set/).waitFor()
  await shot('01-no-key')

  step('save a wrong key -> 401 message; then the right key')
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByPlaceholder('Paste API key').fill('wrong')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('✓ A key is set.').waitFor()
  await page.getByRole('tab', { name: 'Chat' }).click()
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await page.getByPlaceholder(/Message Mistral/).fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText(/401: Unauthorized/).waitFor()
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByPlaceholder(/enter a new key/).fill('test-key')
  await page.getByRole('button', { name: 'Save' }).click()

  step('import an MCP server from JSON and see it connect')
  await page.getByPlaceholder(/mcpServers/).fill(JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [path.join(root, 'tests/fixtures/mini-mcp.mjs')] } } }))
  await page.getByRole('button', { name: 'Import' }).click()
  await page.locator('.badge.connected').waitFor({ timeout: 15000 })
  await page.getByText('Tools: echo').waitFor()
  await shot('02-settings-mcp')

  step('chat streams a reply with a code block')
  await page.getByRole('tab', { name: 'Chat' }).click()
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await page.getByText('1 tool from 1 MCP server').waitFor()
  await page.getByPlaceholder(/Message Mistral/).fill('say hi')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByText('Hello from mock Mistral.').waitFor()
  step('markdown is rendered (and unsafe parts are not)')
  assert.equal(await page.locator('.md strong').first().textContent(), 'Hello')
  assert.equal(await page.locator('.md li').count(), 2)
  assert.equal(await page.locator('.md table td').count(), 2)
  assert.equal(await page.locator('.codeblock-wrap').count(), 1)
  assert.equal(await page.locator('.md a[href="https://example.com"]').count(), 1)
  assert.equal(await page.locator('.md script').count(), 0)
  await page.getByText('<script>alert(1)</script>').waitFor() // shown as text, not executed
  await shot('02b-markdown')

  step('tool call needs approval; deny then allow')
  await page.getByPlaceholder(/Message Mistral/).fill('please echo')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Deny' }).click()
  await page.getByText('denied', { exact: true }).waitFor()
  await page.getByPlaceholder(/Message Mistral/).fill('echo again')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Allow' }).click()
  await page.getByText('The tool said: ECHO:ping').waitFor()
  assert.deepEqual(await page.locator('.toolcard .badge').allTextContents(), ['denied', 'done'])
  assert.equal(await page.getByText('No Mistral API key yet').count(), 0, 'banner must disappear once a key is saved')
  await shot('03-chat-tool')

  step('remote MCP: add by URL, sign in through OAuth, call its tool from chat')
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('button', { name: '＋ Add remote server' }).click()
  const card = page.getByTestId('server-remote-server')
  await card.getByLabel('Name', { exact: true }).fill('remote')
  await page.getByTestId('server-remote').getByPlaceholder('https://example.com/mcp').fill('http://127.0.0.1:8797/mcp')
  await page.getByTestId('server-remote').getByLabel('Enabled').check()
  await page.getByTestId('server-remote').locator('.badge.needs-auth').waitFor({ timeout: 15000 })
  await page.getByTestId('server-remote').getByRole('button', { name: 'Sign in' }).click()
  await page.getByTestId('server-remote').locator('.badge.connected').waitFor({ timeout: 30000 })
  await page.getByTestId('server-remote').getByText('Tools: echo').waitFor()
  await shot('02c-remote')
  await page.getByRole('tab', { name: 'Chat' }).click()
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await page.getByPlaceholder(/Message Mistral/).fill('echo remote please')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Allow' }).click()
  await page.getByText('The tool said: REMOTE:ping').waitFor()

  step('mcpb: install a bundle (settings validated), configure, disable, uninstall')
  await page.getByRole('tab', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Install extension…' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByText('runs code on your computer').waitFor()
  await dlg.getByText('Bundled Demo').first().waitFor()
  assert.equal(await dlg.getByLabel('Greeting').inputValue(), 'hello') // default
  await dlg.getByRole('button', { name: 'Install' }).click()
  await dlg.getByText('Required').waitFor() // api key is required
  await dlg.getByLabel(/API key/).fill('sk-e2e-secret')
  await dlg.getByLabel('Greeting').fill('howdy')
  await shot('02d-install-dialog')
  await dlg.getByRole('button', { name: 'Install' }).click()
  await dlg.waitFor({ state: 'detached' })
  const ext = page.getByTestId('ext-bundled-demo')
  await ext.locator('.badge.connected').waitFor({ timeout: 30000 })
  await ext.getByText('Tools: info').waitFor()
  assert.ok(!fs.readFileSync(path.join(data, 'extensions', 'extensions.json'), 'utf8').includes('sk-e2e-secret'), 'secret must not be written to extensions.json')
  assert.ok(fs.existsSync(path.join(data, 'extensions', 'bundled-demo', 'server', 'index.js')))
  await ext.getByRole('button', { name: 'Settings…' }).click()
  await ext.getByLabel('Greeting').fill('hey')
  await ext.getByRole('button', { name: 'Save' }).click()
  await ext.getByRole('button', { name: 'Settings…' }).waitFor()
  await shot('02e-extension')
  await ext.getByLabel('Enabled').uncheck()
  await ext.locator('.badge.disabled').waitFor()
  await ext.getByRole('button', { name: 'Uninstall' }).click()
  await ext.getByRole('button', { name: 'Remove' }).click()
  await ext.waitFor({ state: 'detached' })
  assert.ok(!fs.existsSync(path.join(data, 'extensions', 'bundled-demo')))

  step('conversation is saved and can be reopened')
  await page.getByRole('tab', { name: 'Chat' }).click()
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await page.locator('.convbtn', { hasText: 'say hi' }).click()
  await page.getByText('The tool said: ECHO:ping').waitFor()

  step('code tab: pick folder, run a task, see the diff, file exists')
  await page.getByRole('tab', { name: 'Code' }).click()
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByPlaceholder(/Tell the agent/).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('textarea[placeholder^="Tell the agent"]').disabled, null, { timeout: 30000 })
  await page.getByPlaceholder(/Tell the agent/).fill('create hello.txt')
  await page.getByRole('button', { name: 'Send' }).last().click()
  await page.getByText('Done: wrote hello.txt').waitFor({ timeout: 30000 })
  await page.locator('.diff-path').first().waitFor()
  assert.equal(await page.locator('.dl.add').count(), 1, 'diff should have exactly one added line')
  await shot('04-code')
  assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'hi from mock\n')

  step('code tab: resume the stored session from History in a fresh Vibe process')
  await page.getByRole('button', { name: 'Change…' }).click()
  await page.getByRole('button', { name: 'History' }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: 'History' }).click()
  await page.locator('.historyitem').first().waitFor({ timeout: 15000 })
  await shot('05-history')
  await page.locator('.historyitem').first().click()
  await page.getByText('Done: wrote hello.txt').waitFor({ timeout: 15000 })
  assert.equal(await page.locator('.msg.user', { hasText: 'create hello.txt' }).count(), 1, 'replayed user message')
  assert.equal(await page.locator('.diff-path').count(), 1, 'replayed diff')
  await page.getByPlaceholder(/Tell the agent/).fill('create hello.txt')
  await page.getByRole('button', { name: 'Send' }).last().click()
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant').length >= 4, null, { timeout: 30000 })
  await page.getByText('Done: wrote hello.txt').nth(1).waitFor({ timeout: 30000 })
  await shot('06-resumed')

  console.log('\nALL STEPS PASSED. Screenshots in', shots)
  await app.close()
  cleanup()
})().catch((e) => { console.error('\nFAILED:', e.message); cleanup(); process.exit(1) })
