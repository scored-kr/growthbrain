import assert from 'node:assert/strict'
import type {BrowserContext,Page} from 'playwright'

export async function checkCaptureRouteIsolation(context: BrowserContext, popup:Page, focusChat:(page:Page)=>Promise<void>) {
  const source = await context.newPage()
  const prefix = '/c/spa-' + crypto.randomUUID()
  async function status() {
    await popup.reload()
    const button = popup.locator('#check-capture')
    await button.waitFor()
    await focusChat(source)
    await button.click()
    const receipt = popup.locator('#capture-result[data-status]')
    await receipt.waitFor()
    return {status:await receipt.getAttribute('data-status'), entries:await popup.locator('#journal-list li p').allTextContents()}
  }
  async function fillChat(name:string, stable = true, append = false) {
    await source.evaluate(({name,stable,append}) => {
      const list = document.querySelector('#messages')!
      if (!append) list.replaceChildren()
      for (const role of ['user','assistant']) {
        const row = document.createElement('article')
        row.dataset.messageAuthorRole = role
        if (stable) row.dataset.messageId = name + '-' + role
        row.dataset.fixtureChat = name
        const body = document.createElement('p')
        body.className = 'markdown'
        body.textContent = name + ' ' + role
        row.append(body)
        list.append(row)
      }
    },{name,stable,append})
  }

  try {
    await source.goto('https://chatgpt.com' + prefix + '-a')
    await fillChat('출발 대화')
    assert.deepEqual((await status()).entries.sort(),['출발 대화 assistant','출발 대화 user'])
    const link = await source.evaluateHandle(path => {
      const link = document.createElement('a')
      link.href = path
      link.textContent = '다른 대화 열기'
      link.onclick = event => event.preventDefault()
      document.body.append(link)
      return link
    },prefix + '-cancelled')
    await link.click()
    await source.waitForTimeout(1700)
    assert.deepEqual((await status()).entries.sort(),['출발 대화 assistant','출발 대화 user'],'A cancelled navigation leaves A usable')
    await fillChat('먼저 렌더링된 다른 대화')
    assert.equal((await status()).status,'route-unverified','A wholly different transcript must not be written under the old URL')
    await fillChat('출발 대화')
    assert.deepEqual((await status()).entries.sort(),['출발 대화 assistant','출발 대화 user'])
    await source.evaluate(path => history.pushState({},'',path),prefix + '-b')
    assert.equal((await status()).status,'route-unverified','A remains visible under B URL')
    await fillChat('도착 대화',true,true)
    assert.equal((await status()).status,'route-unverified','A and B overlap during loading')
    await source.locator('[data-fixture-chat="출발 대화"]').evaluateAll(nodes => nodes.forEach(node => node.remove()))
    assert.deepEqual((await status()).entries.sort(),['도착 대화 assistant','도착 대화 user'],
      'A complete replacement is captured automatically for canonical B')
    await fillChat('출발 대화',true,true)
    assert.equal((await status()).status,'route-unverified','Recreated A frames remain ineligible by stable identity')
    await source.locator('[data-fixture-chat="출발 대화"]').evaluateAll(nodes => nodes.forEach(node => node.remove()))
    assert.deepEqual((await status()).entries.sort(),['도착 대화 assistant','도착 대화 user'])
    await source.evaluate(path => history.pushState({},'',path),prefix + '-c')
    await fillChat('익명 도착',false)
    assert.equal((await status()).status,'route-unverified','An unidentifiable replacement offers no source proof')
    await source.reload()
    await fillChat('익명 도착',false)
    assert.deepEqual((await status()).entries.sort(),['익명 도착 assistant','익명 도착 user'],
      'A fresh document at C can store local-only messages')
  } finally { await source.close() }
}
