// 纯逻辑自测：把浏览器 bundle 在 Node 里装进一个假 window，验证抠字/切句。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let definition = null
const storage = new Map()

globalThis.window = {
  __ModuleLoader__: { load: (def) => { definition = def } },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  },
  document: {
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {} }),
    body: { appendChild() {} },
    head: { appendChild() {} },
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => { throw new Error('no network in test') },
  location: { href: 'test://' },
  addEventListener: () => {},
  removeEventListener: () => {},
}

const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

// 执行 bundle：它只会调用 __ModuleLoader__.load 注册 factory
new Function('window', 'require', 'globalThis', bundle)(globalThis.window, () => reactStub, globalThis)
assert.ok(definition, 'bundle 没有注册到 __ModuleLoader__')

const mod = definition.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})

assert.equal(typeof mod.apply, 'function', 'exports.apply 缺失')
assert.deepEqual(mod.inject, ['slots'])
const { cleanText, splitSpeech } = mod.__internals

// 1) markdown 抠成能念的人话
const raw = [
  '## 结论',
  '',
  '**核心**：这是 `code` 片段，链接 [文档](https://example.com) 也要去掉。',
  '- 列表第一项',
  '- 列表第二项',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| a | b |',
  '结尾一句。',
].join('\n')

const cleaned = cleanText(raw)
assert.ok(!cleaned.includes('```'), 'code fence 没清掉')
assert.ok(!cleaned.includes('**'), '粗体没清掉')
assert.ok(!cleaned.includes('https://example.com'), '链接 URL 没清掉')
assert.ok(!cleaned.includes('| ---'), '表格分隔没清掉')
assert.ok(cleaned.includes('结论'), '正文丢了')
assert.ok(cleaned.includes('文档'), '链接文字应保留')
assert.ok(cleaned.includes('结尾一句。'), '结尾丢了')

// 2) 切句：短句合并、长句不超限
const chunks = splitSpeech('第一句。第二句！第三句？' + '很长的句子'.repeat(60), 100)
assert.ok(chunks.length >= 3, '长文本没被切开: ' + chunks.length)
for (const chunk of chunks) assert.ok(chunk.length <= 100, `切片超长 ${chunk.length}`)
assert.ok(chunks.join('').replace(/\s/g, '').length >= 300, '切片内容丢太多')

// 3) 空白输入不产生音频片段
assert.deepEqual(splitSpeech('   \n\n  ', 200), [])

console.log('client logic ok:', { chunks: chunks.length })
