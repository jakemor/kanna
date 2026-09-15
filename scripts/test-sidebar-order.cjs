// Run with: bun scripts/test-sidebar-order.cjs (requires Playwright Chromium).
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
async function main() {
  const build = await Bun.build({ entrypoints: ['src/client/components/chat-ui/sidebar/SortableChatList.browser.tsx'], target: 'browser' })
  assert.equal(build.success, true, String(build.logs))
  const server = Bun.serve({ port: 0, fetch: req => new URL(req.url).pathname === '/app.js' ? new Response(build.outputs[0], { headers: { 'Content-Type': 'text/javascript' } }) : new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { 'Content-Type': 'text/html' } }) })
  let browser
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }) } catch (error) { server.stop(); throw error }
  try {
    const page = await browser.newPage()
    await page.goto(`http://localhost:${server.port}`)
    const ids = () => page.locator('[data-task]').evaluateAll(nodes => nodes.map(n => n.dataset.task))
    await page.getByRole('button', { name: 'Reorder task' }).nth(2).focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Space')
    await page.waitForFunction(() => document.querySelector('[data-task]')?.dataset.task === 'old')
    assert.deepEqual(await ids(), ['old', 'recent-a', 'recent-b'])
    await page.keyboard.press('1')
    assert.equal(await page.locator('output').textContent(), 'old')
    await page.getByText('Toggle preview').click()
    assert.deepEqual(await ids(), ['recent-a', 'recent-b'])
    await page.keyboard.press('1')
    assert.equal(await page.locator('output').textContent(), 'recent-a')
    await page.getByText('Toggle preview').click()
    assert.deepEqual(await ids(), ['old', 'recent-a', 'recent-b'])
    await page.reload()
    await page.getByText('Reset order').waitFor()
    assert.deepEqual(await ids(), ['old', 'recent-a', 'recent-b'])
    await page.getByText('Reset order').click()
    assert.deepEqual(await ids(), ['recent-a', 'recent-b', 'old'])
    console.log('PASS: keyboard drag, collapse, expand, numeric target, persistence and reset')
  } finally { await browser.close(); server.stop() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
