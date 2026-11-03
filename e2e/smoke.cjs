// End-to-end smoke test: drives the real Electron app with Playwright.
// Needs: npm run build; vibe-acp installed (VIBE_ACP=/path/to/vibe-acp); Playwright available.
// Run under a display, e.g.: xvfb-run -a node e2e/smoke.cjs
const { _electron: electron } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

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

const servers = [
  spawn(process.execPath, [path.join(__dirname, 'mock-mistral.mjs')], { stdio: 'inherit' }),
  spawn(process.execPath, [path.join(__dirname, 'mock-vibe-llm.mjs')], { stdio: 'inherit' })
]
const cleanup = () => servers.forEach((s) => s.kill())

;(async () => {
  await new Promise((r) => setTimeout(r, 800))
  const app = await electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: [root, '--no-sandbox'],
    env: { ...process.env, MISTRAL_DESKTOP_DATA: data, MISTRAL_DESKTOP_TEST_FOLDER: project, MOCK_KEY: 'x', MISTRAL_API_KEY: '' }
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
  assert.equal(await page.locator('.codeblock').count(), 1)

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

  step('conversation is saved and can be reopened')
  await page.getByRole('button', { name: '＋ New chat' }).click()
  await page.locator('.convbtn').first().click()
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

  console.log('\nALL STEPS PASSED. Screenshots in', shots)
  await app.close()
  cleanup()
})().catch((e) => { console.error('\nFAILED:', e.message); cleanup(); process.exit(1) })
