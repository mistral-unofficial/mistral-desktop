// End-to-end test for `@` file completion in the Code tab. Independent of the other e2e flow.
// Needs: npm run build; VIBE_ACP=/path/to/vibe-acp; Playwright; a display (xvfb-run -a node e2e/mentions.cjs)
const { _electron: electron } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
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
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ vibePath: VIBE_ACP, vibeHome: vhome }))

// A small git project: tracked, untracked, ignored, nested and oddly named files.
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); fs.writeFileSync(path.join(project, rel), text) }
execFileSync('git', ['init', '-q'], { cwd: project })
put('README.md', '# demo\n')
put('src/app.ts', 'export const app = 1\n')
put('src/components/Button.tsx', 'export const Button = 2\n')
put('docs/guide.md', 'guide\n')
put('my notes/todo list.txt', 'buy milk\n')
put('.gitignore', '*.log\n')
put('secret.log', 'nope\n')
execFileSync('git', ['add', 'README.md', 'src'], { cwd: project })

let llmLog = ''
const llm = spawn(process.execPath, [path.join(__dirname, 'mock-vibe-llm.mjs')], { stdio: ['ignore', 'inherit', 'pipe'] })
llm.stderr.on('data', (d) => { llmLog += d; process.stderr.write(d) })
const cleanup = () => llm.kill()

;(async () => {
  await new Promise((r) => setTimeout(r, 800))
  const app = await electron.launch({
    executablePath: require(path.join(root, 'node_modules/electron')),
    args: [root, '--no-sandbox'],
    env: { ...process.env, MISTRAL_DESKTOP_DATA: data, MISTRAL_DESKTOP_TEST_FOLDER: project, MOCK_KEY: 'x', MISTRAL_API_KEY: '' }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.error('[pageerror]', e.message))
  await page.setViewportSize({ width: 1100, height: 760 })
  const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') })
  const step = (s) => console.log('•', s)
  const box = () => page.getByPlaceholder(/Tell the agent/)
  const list = page.getByRole('listbox', { name: 'Files' })
  const options = async () => (await list.getByRole('option').allTextContents()).map((t) => t.replace(/^[^\w."]*/, '').trim())
  const clear = async () => { await box().fill('') }

  await page.getByRole('tab', { name: 'Code' }).click()
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.waitForFunction(() => { const t = document.querySelector('textarea[placeholder^="Tell the agent"]'); return t && !t.disabled }, null, { timeout: 30000 })

  step('a bare @ lists the top level: no hidden files, no ignored files')
  await box().click()
  await box().pressSequentially('@')
  await list.waitFor()
  const top = await options()
  assert.ok(top.some((t) => t.startsWith('src/')) && top.some((t) => t.startsWith('README.md')) && top.some((t) => t.startsWith('docs/')), top.join(' | '))
  assert.ok(!top.some((t) => /secret\.log|\.gitignore|\.git\b/.test(t)), 'hidden/ignored entries must not be listed: ' + top.join(' | '))
  await shot('mention-01-top-level')

  step('fuzzy search finds a nested file; Enter inserts the full path and a space')
  await clear()
  await box().pressSequentially('open @app')
  await list.waitFor()
  assert.match((await options())[0], /^app\.ts/)
  await shot('mention-02-fuzzy')
  await box().press('Enter')
  assert.equal(await box().inputValue(), 'open @src/app.ts ')
  assert.equal(await list.count(), 0, 'popup closes after accepting a file')

  step('scattered letters match, arrow keys move the selection, Tab accepts')
  await clear()
  await box().pressSequentially('@btn')
  await list.waitFor()
  assert.ok((await options()).some((t) => t.startsWith('Button.tsx')))
  await clear()
  await box().pressSequentially('@u') // matches several files
  await list.getByRole('option').nth(1).waitFor()
  const second = (await options())[1]
  await box().press('ArrowDown')
  assert.equal(await list.getByRole('option', { selected: true }).count(), 1)
  await box().press('ArrowDown')
  await box().press('ArrowUp')
  await box().press('Tab')
  const picked = await box().inputValue()
  assert.ok(picked.startsWith('@') && picked.endsWith(' '), picked)
  assert.ok(second.length > 0)

  step('folders: completing one keeps the mention open and lists its content; names with spaces are quoted')
  await clear()
  await box().pressSequentially('@my')
  await list.waitFor()
  assert.match((await options())[0], /^my notes\//)
  await box().press('Enter')
  assert.equal(await box().inputValue(), '@"my notes/')
  await list.getByRole('option', { name: /todo list\.txt/ }).waitFor()
  await shot('mention-03-folder')
  await box().press('Enter')
  assert.equal(await box().inputValue(), '@"my notes/todo list.txt" ')

  step('Escape closes the popup without losing text; no match is reported; emails and plain text do not trigger it')
  await clear()
  await box().pressSequentially('@sr')
  await list.waitFor()
  await box().press('Escape')
  assert.equal(await list.count(), 0)
  assert.equal(await box().inputValue(), '@sr')
  await clear()
  await box().pressSequentially('@zzzqqq')
  await list.getByText('No matching files').waitFor()
  await clear()
  await box().pressSequentially('mail me@exa')
  assert.equal(await list.count(), 0)

  step('clicking an entry inserts it')
  await clear()
  await box().pressSequentially('@guide')
  await list.getByRole('option').first().click()
  assert.equal(await box().inputValue(), '@docs/guide.md ')

  step('sending: Vibe attaches the mentioned files, each exactly once, and ignored files stay out')
  await clear()
  await box().pressSequentially('summarize @src/app.ts and @"my notes/todo list.txt" ')
  await box().press('Enter') // popup is closed (trailing space), so Enter sends
  await page.getByText('Done: wrote hello.txt').waitFor({ timeout: 30000 })
  await page.locator('.msg.user', { hasText: 'summarize @src/app.ts' }).waitFor()
  // The mock logs the user message of every model request (before and after the tool call): check each one separately.
  const requests = llmLog.split('\n').filter((l) => l.startsWith('[user-message]'))
  assert.ok(requests.length >= 1, 'the model should have received the prompt')
  const count = (line, needle) => line.split(needle).length - 1
  for (const line of requests) {
    assert.equal(count(line, 'export const app = 1'), 1, 'src/app.ts must be attached exactly once per request:\n' + line)
    assert.equal(count(line, 'buy milk'), 1, '"my notes/todo list.txt" must be attached exactly once per request')
    assert.ok(!line.includes('nope'), 'ignored files are not attached')
  }
  await shot('mention-04-sent')

  console.log('\nALL STEPS PASSED. Screenshots in', shots)
  await app.close()
  cleanup()
})().catch((e) => { console.error('\nFAILED:', e.message); cleanup(); process.exit(1) })
