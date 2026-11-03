// 浏览器端冒烟测试：手搓一个最小 DOM，把 bundle 真正跑起来。
// 覆盖：启动不重念历史 / 新回复自动念 / 消息栏按钮插在"用量"前面 / 点按钮念这条 / 关掉后不再自动念。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

// ── 迷你 DOM ────────────────────────────────────────────────────────────────
function matchSelector(node, selector) {
  return String(selector).split(',').some((part) => {
    if (part.trim().startsWith('.')) {
      const cls = part.trim().slice(1)
      return String(node.attrs.class || '').split(/\s+/).includes(cls)
    }
    const tokens = part.trim().match(/\[[^\]]+\]|[A-Za-z][\w-]*/g) || []
    if (!tokens.length) return false
    return tokens.every((token) => {
      if (token.startsWith('[')) {
        const body = token.slice(1, -1)
        const eq = body.match(/^([\w-]+)="([^"]*)"$/)
        if (eq) return node.attrs[eq[1]] === eq[2]
        return Object.hasOwn(node.attrs, body)
      }
      return (node.tagName || '').toLowerCase() === token.toLowerCase()
    })
  })
}

class Node_ {
  constructor(tag, attrs, text) {
    this.tagName = String(tag || '').toUpperCase()
    this.attrs = attrs || {}
    this.nodeValue = text === undefined ? null : text
    this.children = []
    this.parentElement = null
    this.style = {}
    this.dataset = {}
    this.listeners = {}
    this.innerHTML = ''
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  get className() { return this.attrs.class || '' }
  set className(value) { this.attrs.class = String(value) }
  get classList() {
    const node = this
    const list = () => String(node.attrs.class || '').split(/\s+/).filter(Boolean)
    return {
      add(name) { const set = new Set(list()); set.add(name); node.attrs.class = Array.from(set).join(' ') },
      remove(name) { node.attrs.class = list().filter((c) => c !== name).join(' ') },
      contains(name) { return list().includes(name) },
    }
  }
  get id() { return this.attrs.id || '' }
  set id(value) { this.attrs.id = String(value) }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child }
  insertBefore(child, anchor) {
    const index = this.children.indexOf(anchor)
    child.parentElement = this
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }
  remove() {
    if (!this.parentElement) return
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index >= 0) siblings.splice(index, 1)
    this.parentElement = null
  }
  matches(selector) { return matchSelector(this, selector) }
  contains(other) {
    let node = other
    while (node) {
      if (node === this) return true
      node = node.parentElement
    }
    return false
  }
  closest(selector) {
    let node = this
    while (node) {
      if (node.tagName && matchSelector(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
  querySelectorAll(selector) {
    const out = []
    walk(this, (node) => { if (node !== this && node.tagName && node.matches(selector)) out.push(node) })
    return out
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  get lastElementChild() {
    for (let i = this.children.length - 1; i >= 0; i--) if (this.children[i].tagName) return this.children[i]
    return null
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener() {}
  click() { for (const fn of this.listeners.click || []) fn({ target: this, preventDefault() {}, stopPropagation() {} }) }
  getBoundingClientRect() { return { left: 100, top: 100, width: 20, height: 20, bottom: 120, right: 120 } }
  get textContent() {
    if (this.nodeValue !== null) return this.nodeValue
    return this.children.map((c) => c.textContent).join('')
  }
  set textContent(value) { this.children = []; this.nodeValue = String(value) }
  get innerText() { return this.textContent }
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

class Document_ {
  constructor() {
    this.documentElement = new Node_('html')
    this.body = this.documentElement.appendChild(new Node_('body'))
    this.head = this.documentElement.appendChild(new Node_('head'))
    this.listeners = {}
  }
  createElement(tag) { return new Node_(String(tag).toUpperCase()) }
  getElementById(id) {
    let found = null
    walk(this.documentElement, (node) => { if (!found && node.attrs && node.attrs.id === id) found = node })
    return found
  }
  querySelectorAll(selector) {
    const out = []
    walk(this.documentElement, (node) => { if (node.tagName && node.matches(selector)) out.push(node) })
    return out
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  createTreeWalker(root) {
    const stack = []
    walk(root, (node) => stack.push(node))
    const texts = stack.filter((node) => node.nodeValue !== null)
    let index = 0
    return { nextNode: () => (index < texts.length ? texts[index++] : null) }
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener() {}
}

const doc = new Document_()
const requests = []
const audioInstances = []
let speakCount = 0

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload },
    async text() { return JSON.stringify(payload) },
    async blob() { return { type: 'audio/wav', size: 1024 } },
  }
}

const fetchStub = async (url, init) => {
  requests.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body })
  if (String(url).endsWith('/tts')) { speakCount++; return makeResponse(200, {}) }
  if (String(url).endsWith('/voices')) return makeResponse(200, { ok: true, voices: [{ name: 'Microsoft Huihui Desktop', culture: 'zh-CN', enabled: true }], default: '' })
  return makeResponse(200, { ok: true, status: {} })
}

class Audio_ {
  constructor(src) { this.src = src; this.volume = 1; audioInstances.push(this) }
  play() { setImmediate(() => { if (this.onended) this.onended() }); return Promise.resolve() }
  pause() {}
}

const intervals = []
const tickNow = () => { const fn = intervals[0]; if (typeof fn === 'function') fn() }
const storage = new Map()

const fakeWindow = {
  __ModuleLoader__: { load: (def) => { fakeWindow.__definition = def } },
  document: doc,
  location: { href: 'dsh-app://app/', origin: 'dsh-app://app' },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  },
  fetch: fetchStub,
  Audio: Audio_,
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
  innerWidth: 1280,
  setTimeout: (fn, ms) => { if (ms >= 50) setImmediate(fn); else fn(); return 0 },
  clearTimeout: () => {},
  setInterval: (fn) => { intervals.push(fn); return intervals.length },
  clearInterval: (id) => { if (id >= 1) intervals[id - 1] = null },
  addEventListener: () => {},
  removeEventListener: () => {},
  speechSynthesis: { getVoices: () => [], cancel: () => {}, speak: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
  SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
}

const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

new Function('window', 'require', 'globalThis', bundle)(fakeWindow, () => reactStub, globalThis)
const definition = fakeWindow.__definition
assert.ok(definition, 'bundle 没有注册')

const mod = definition.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})
const internals = mod.__internals

// ── 假 ctx ─────────────────────────────────────────────────────────────────
const registered = []
const ctx = {
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  slots: {
    inject(name, factory) { return factory() },
    register(descriptor, component) { registered.push({ descriptor, component }); return () => {} },
  },
}

mod.apply(ctx)
assert.equal(registered.length, 1, '设置页没注册')
assert.equal(registered[0].descriptor.name, 'settings.section')
assert.equal(typeof intervals[0], 'function', '没开始盯聊天区')

const flush = () => new Promise((r) => setTimeout(r, 5))
const realNow = Date.now
let clock = realNow()

// 1) 首屏问候
await flush()
await flush()
assert.ok(requests.some((r) => r.url.endsWith('/tts')), '问候没有触发合成请求')

// 2) 造聊天区：一轮 = 步骤 + 操作栏（复制 / 分支 / 用量 / 时间）
function addTurn(turn, text) {
  const flow = doc.body.appendChild(new Node_('div', { 'data-chat-flow': '', 'data-chat-turn': String(turn) }))
  const step = flow.appendChild(new Node_('div', { 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': String(turn) }))
  step.appendChild(new Node_('p', {}, text))
  const tail = flow.appendChild(new Node_('div', { 'data-turn-tail': String(turn) }))
  const row = tail.appendChild(new Node_('div', { 'data-clock': 'end' }))
  row.appendChild(new Node_('span', { 'aria-label': '复制' }, ''))
  row.appendChild(new Node_('span', { 'aria-label': '分支' }, ''))
  const info = row.appendChild(new Node_('span', {}, ''))
  info.appendChild(new Node_('span', {}, '用量 1.2K tok'))
  return { flow, step, tail, row, info }
}

const first = addTurn(1, '历史上早就说过的一句话。')
internals.watch.warmUntil = 0 // 跳过预热，便于断言
clock = realNow() + 10000
Date.now = () => clock
tickNow()
assert.equal(speakCount, 1, '打开时把历史也念了')

// 2.5) 主题判定：浅色页面必须走浅色面板（否则黑底黑字）
fakeWindow.getComputedStyle = (el) => ({ backgroundColor: el && el.__bg ? el.__bg : 'rgba(0, 0, 0, 0)' })
doc.body.__bg = 'rgb(255, 255, 255)'
assert.equal(internals.detectTheme(), 'light', '浅色主题判错了')
doc.body.__bg = 'rgb(20, 21, 24)'
assert.equal(internals.detectTheme(), 'dark', '深色主题判错了')
doc.body.__bg = ''
assert.equal(internals.parseColor('#fff').a, 1)
assert.equal(internals.parseColor('rgb(1, 2, 3)').g, 2)
assert.equal(internals.parseColor('nope'), null)
doc.body.__bg = 'rgb(255, 255, 255)'

// 3) 消息栏按钮：插在"用量/时间"前面 = 分支键后面
mod.__internals.sweepRowActions()
const buttons = first.row.querySelectorAll('.dshv-act')
assert.equal(buttons.length, 1, '消息栏没插上按钮')
const branchIndex = first.row.children.findIndex((c) => c.getAttribute('aria-label') === '分支')
const buttonIndex = first.row.children.indexOf(buttons[0])
const infoIndex = first.row.children.indexOf(first.info)
assert.ok(buttonIndex > branchIndex, `按钮没在分支键后面（分支 ${branchIndex}, 按钮 ${buttonIndex}）`)
assert.equal(buttonIndex, infoIndex - 1, '按钮没紧挨着用量前面')

// 4) 正在生成时冒出来的新回复 → 说完自动念
const setRunning = (on) => {
  if (on) {
    if (!doc.querySelector('[data-chat-running]')) doc.body.appendChild(new Node_('div', { 'data-chat-running': 'true' }))
  } else {
    for (const node of [...doc.querySelectorAll('[data-chat-running]')]) node.remove()
  }
}
const before = speakCount
setRunning(true)
const second = addTurn(2, '新的一条回复，讲的是语音播报。')
tickNow() // 第一次看到 + 正在跑 → 只登记，等着
await flush()
assert.equal(speakCount, before, '还在流式时就出声了')
setRunning(false)
clock += 5000
tickNow()
await flush()
assert.equal(speakCount, before + 1, '说完了却没念')
const lastBody = JSON.parse(requests.filter((r) => r.url.endsWith('/tts')).at(-1).body)
assert.ok(String(lastBody.text).includes('语音播报'), '念的不是这条: ' + lastBody.text)

// 4.4) 自动播报只划"正在念的那一段"，不能把整条消息都划了
const multi = addTurn(3, '第一段内容。')
multi.step.appendChild(new Node_('p', {}, '第二段内容。'))
setRunning(true)
clock += 1000
tickNow()            // 首次看到（正在跑）→ 登记
setRunning(false)
clock += 5000
tickNow()            // 说完 → 念 + 高亮
const marked = doc.querySelectorAll('.dshv-reading')
assert.ok(marked.length <= 1, '高亮铺满整条消息了：' + marked.length + ' 个元素')
if (marked.length === 1) {
  assert.equal(String(marked[0].tagName).toLowerCase(), 'p', '高亮打在了容器上：' + marked[0].tagName)
}
await flush()

// 4.5) 切工作区：不是"正在生成"时第一次看到的轮次，一律当旧内容，不念
const enterBefore = speakCount
addTurn(9, '这是切进工作区时就有的旧内容，不该被念。')
clock += 5000
tickNow()
await flush()
assert.equal(speakCount, enterBefore, '切进工作区就把旧内容念了')

// 5) 点这一轮的喇叭 → 念"按钮上方那条"的全文，且不套 600 字上限
const longBody = '这是一段很长的正文。'.repeat(70) // ~700 字，超过自动播报的 600 字上限
const extra = second.flow.appendChild(new Node_('div', { 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '2' }))
extra.appendChild(new Node_('p', {}, longBody))
assert.equal(internals.turnTextFrom(second.row), longBody, 'turnTextFrom 没取到按钮上方那条')
mod.__internals.sweepRowActions()
const secondButton = second.row.querySelectorAll('.dshv-act')[0]
assert.ok(secondButton, '第二轮没按钮')
const manualFrom = requests.length
secondButton.click()
await flush()
const spoken = requests.slice(manualFrom)
  .filter((r) => r.url.endsWith('/tts'))
  .map((r) => String(JSON.parse(r.body).text))
  .join('')
assert.ok(spoken.includes('很长的正文'), '念的内容不对: ' + spoken.slice(0, 40))
assert.ok(spoken.length >= 600, `手动点击被截断了，只念了 ${spoken.length} 字`)

// 6) 关掉自动播报：新回复不再自动念，但手点还能念
internals.setConfig({ enabled: false })
await flush()
const offBefore = speakCount
addTurn(3, '第三轮回复，关掉之后不该自动出声。')
clock += 5000
tickNow()
await flush()
assert.equal(speakCount, offBefore, '关掉后还自动念')
internals.speakNow('手动点一下也要能念。')
await flush()
assert.equal(speakCount, offBefore + 1, '关掉后手动也念不了')

// 7) 暂停 / 继续：暂停保留队首那一段，继续时从它接着念
internals.audio.queue.length = 0
const pauseBase = speakCount
internals.speakNow('暂停测试第一段。')
await flush()
internals.speakNow('暂停测试第二段，这一段比较长，用来验证暂停后还能接着念。')
internals.pauseAll()
assert.equal(internals.isPaused(), true, '没进入暂停态')
assert.ok(internals.audio.queue.length >= 1, '暂停把队列清空了（那就变成停止了）')
const headBefore = internals.audio.queue[0]
internals.resumeAll()
assert.equal(internals.isPaused(), false, '没退出暂停态')
await flush()
await flush()
assert.ok(speakCount > pauseBase, '继续之后没有再出声')
const headText = typeof headBefore === 'string' ? headBefore : headBefore.text
assert.ok(headText.length > 0)

// 8) 继续时从「念到的那个字」接着念，而不是从头
await new Promise((r) => setTimeout(r, 150))
internals.audio.queue.length = 0
internals.audio.queue.push('零一二三四五六七八九十')
internals.pauseAll()
internals.audio.resumeFrom = 6
internals.resumeAll()
await flush()
await flush()
const resumed = requests.filter((r) => r.url.endsWith('/tts')).at(-1)
const resumedText = String(JSON.parse(resumed.body).text)
assert.ok(resumedText.startsWith('六'), `没有从暂停处继续，念的是: ${resumedText}`)

// 9) 念到哪段就给哪段画下划线
const fourth = addTurn(4, '第一段落。')
fourth.step.appendChild(new Node_('p', {}, '第二段落。'))
const parsed4 = internals.turnBlocksFrom(fourth.row)
assert.equal(parsed4.blocks.length, 2, '块数不对: ' + parsed4.blocks.length)
assert.equal(parsed4.text, '第一段落。\n第二段落。', '块拼出来的文本不对: ' + JSON.stringify(parsed4.text))
internals.speakNow(parsed4.text, parsed4.blocks)
// pump 是同步跑到第一次 await 的，所以此刻就该已经高亮了第一段
assert.ok(parsed4.blocks[0].el.classList.contains('dshv-reading'), '第一段没有被画下划线')
await flush()
await flush()
assert.equal(internals.readingEl(), null, '念完之后下划线没清掉')

Date.now = realNow
console.log('dom smoke ok:', { tts: speakCount, audio: audioInstances.length, buttons: doc.querySelectorAll('.dshv-act').length })
