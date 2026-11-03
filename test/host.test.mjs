// 宿主半身自测：假 ctx 跑 apply，然后把注册的路由当真 HTTP handler 调一遍。
// 注意：沙箱里的进程是 Low 完整性，SAPI 取不到音色 —— 这里验证的正是"失败也要说清楚原因"。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-test-'))
process.env.DSH_HOME = tmpHome

const { default: plugin } = await import('../lib/index.js')
assert.equal(typeof plugin.apply, 'function', 'plugin.apply 缺失')
assert.deepEqual(plugin.inject, ['webServer', 'connection'])

const routes = new Map()
const ctx = {
  webServer: {
    register(descriptor) {
      routes.set(descriptor.path, descriptor.handler)
      return () => routes.delete(descriptor.path)
    },
  },
  connection: {
    isTrusted: () => true,
    requestRejection: () => undefined,
  },
  get(name) {
    if (name === 'connection') return ctx.connection
    if (name === 'webServer') return ctx.webServer
    return undefined
  },
}

const dispose = plugin.apply(ctx)
assert.ok(routes.size >= 3, '路由没注册全: ' + [...routes.keys()].join(','))

function makeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:11006', origin: 'http://127.0.0.1:11006' }
  if (body !== undefined) {
    req.push = null
    setImmediate(() => { req.emit('data', Buffer.from(body, 'utf8')); req.emit('end') })
  } else {
    setImmediate(() => req.emit('end'))
  }
  return req
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { res.headers[key.toLowerCase()] = value },
    end(chunk) { res.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0) },
  }
  return res
}

async function call(routePath, method, body) {
  const handler = routes.get(routePath)
  assert.ok(handler, '没有路由 ' + routePath)
  const res = makeRes()
  await handler(makeReq(method, body), res)
  return res
}

// 1) 音色接口：能列出来最好；列不出来也必须说清原因（沙箱里 spawn 会被拦，属预期）
const voicesRes = await call('/dsh-voice/api/voices', 'GET')
const voicesPayload = JSON.parse(voicesRes.body.toString('utf8'))
assert.ok(voicesRes.statusCode === 200 || voicesRes.statusCode === 500, '意外状态码 ' + voicesRes.statusCode)
assert.equal(typeof voicesPayload.ok, 'boolean')
assert.ok(Array.isArray(voicesPayload.voices))
if (!voicesPayload.ok) assert.ok(voicesPayload.error, '失败却没有原因')
console.log('voices ->', JSON.stringify({ code: voicesRes.statusCode, ok: voicesPayload.ok, count: voicesPayload.voices.length, error: (voicesPayload.error || '').slice(0, 80) }))

// 2) 合成接口：失败路径必须给出人能看懂的原因
const ttsRes = await call('/dsh-voice/api/tts', 'POST', JSON.stringify({ text: '测试一下' }))
if (ttsRes.statusCode === 200) {
  assert.equal(ttsRes.headers['content-type'], 'audio/wav')
  assert.ok(ttsRes.body.length > 1000, 'WAV 太小')
  assert.equal(ttsRes.body.subarray(0, 4).toString('ascii'), 'RIFF')
  console.log('tts -> ok, wav bytes', ttsRes.body.length)
} else {
  assert.equal(ttsRes.statusCode, 500)
  const payload = JSON.parse(ttsRes.body.toString('utf8'))
  assert.ok(payload.error && payload.error.length > 0, '失败却没有原因')
  console.log('tts -> 失败（预期内，沙箱无 SAPI 音色）:', payload.error.slice(0, 80))
}

// 3) 空文本要拒绝
const emptyRes = await call('/dsh-voice/api/tts', 'POST', JSON.stringify({ text: '   ' }))
assert.equal(emptyRes.statusCode, 400)

// 4) 状态接口：写进去的东西要能读回来
const postRes = await call('/dsh-voice/api/status', 'POST', JSON.stringify({ browser: { voices: ['x'], domMiss: false } }))
assert.equal(postRes.statusCode, 200)
const getRes = await call('/dsh-voice/api/status', 'GET')
const status = JSON.parse(getRes.body.toString('utf8')).status
assert.deepEqual(status.browser.voices, ['x'])
assert.ok(status.host && typeof status.host.sapiOk === 'boolean', '自检没写进状态')
assert.ok(fs.existsSync(path.join(tmpHome, 'voice', 'status.json')), '状态文件没落盘')

// 5) 卸载要把路由摘掉
dispose()
assert.equal(routes.size, 0, '卸载后路由还在: ' + [...routes.keys()].join(','))

fs.rmSync(tmpHome, { recursive: true, force: true })
console.log('host routes ok')
