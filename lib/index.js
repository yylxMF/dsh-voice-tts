/**
 * dsh-voice —— 宿主侧半身：把文字变成声音。
 *
 * 职责只有三件：
 *   1. 合成：POST /dsh-voice/api/tts  → Windows SAPI（System.Speech）合成 WAV 字节，回给浏览器播。
 *      为什么不在浏览器里直接播？Electron 的 speechSynthesis 在部分构建里没有可用音色，
 *      而 Windows 自带的 SAPI 音色是机器上现成的（中文机器一般有 Huihui），所以两条腿走路。
 *   2. 音色：GET  /dsh-voice/api/voices → 列出本机 SAPI 音色（可用/不可用会分开说）。
 *   3. 自检：启动时探一次 SAPI，并把结果写进 $DSH_HOME/voice/status.json。
 *      这样"语音到底能不能用"有据可查，而不是靠猜。
 *
 * 安全：DSH 的 Web 端口在回环地址上，但浏览器里任何一个网页都能向回环发请求，
 *      所以所有路由都过一遍 connection.requestRejection 的信任栅栏（fail-closed，缺服务就拒）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'voice')
const STATUS_FILE = path.join(STATE_DIR, 'status.json')
const LOG_FILE = path.join(STATE_DIR, 'voice.log')
const TMP_DIR = path.join(os.tmpdir(), 'dsh-voice')

const IS_WINDOWS = process.platform === 'win32'

const PS_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)

const MAX_TEXT = 4000
const MAX_BODY = 64 * 1024
const SYNTH_TIMEOUT_MS = 60_000
const VOICES_TIMEOUT_MS = 20_000

function ensureDirs() {
  for (const dir of [STATE_DIR, TMP_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 权限问题留给调用点报错 */ }
  }
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch { /* 日志失败不影响主流程 */ }
}

/** 读 WAV 的 data 块算时长：自检时用来证明"不是一段静音"。 */
function wavDuration(bytes) {
  try {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = bytes.readUInt32LE(28);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (id === 'data') return byteRate ? Number((size / byteRate).toFixed(2)) : null;
      offset += 8 + size + (size % 2);
    }
  } catch { /* 不是标准 WAV 就算了 */ }
  return null;
}

function readStatus() {  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) } catch { return {} }
}

function writeStatus(patch) {
  const next = { ...readStatus(), ...patch, updatedAt: new Date().toISOString() }
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2)) } catch (e) { log('writeStatus failed', String(e?.message ?? e)) }
  return next
}

/** 跑一个 .ps1：结果由脚本自己写进 -Result 文件（避免 PowerShell 5.1 重定向时的编码坑）。 */
function runScript(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const file = path.join(HERE, script)
    try {
      execFile(
        PS_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env } },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }),
      )
    } catch (e) {
      // 某些受限环境（例如被策略限制的进程）里 spawn 会同步抛 EPERM，
      // 这里转成 resolve，让上层走"失败但说清原因"的分支，而不是把整个路由打成异常。
      resolve({ err: e, stdout: '', stderr: String(e?.message ?? e) })
    }
  })
}

async function listVoices() {
  if (!IS_WINDOWS) return { ok: false, voices: [], default: '', error: '本机合成只支持 Windows（PowerShell + System.Speech）；macOS/Linux 请用浏览器音色' }
  ensureDirs()
  const resultFile = path.join(TMP_DIR, `voices-${crypto.randomUUID()}.json`)
  try {
    const run = await runScript('voices.ps1', ['-Result', resultFile], VOICES_TIMEOUT_MS)
    let payload = null
    try { payload = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { /* 下面统一报错 */ }
    if (!payload) {
      const detail = (run.stderr || run.stdout || (run.err && run.err.message) || '').trim()
      return { ok: false, voices: [], default: '', error: detail || '音色枚举失败（脚本没有产出结果）' }
    }
    const voices = Array.isArray(payload.voices) ? payload.voices : payload.voices ? [payload.voices] : []
    return { ok: payload.ok !== false, voices, default: payload.default || '', error: payload.error || '' }
  } finally {
    try { fs.unlinkSync(resultFile) } catch { /* 临时文件，删不掉也无所谓 */ }
  }
}

async function synthesize(text, options) {
  if (!IS_WINDOWS) return { ok: false, error: '本机合成只支持 Windows（PowerShell + System.Speech）；macOS/Linux 请用浏览器音色' }
  ensureDirs()
  const id = crypto.randomUUID()
  const requestFile = path.join(TMP_DIR, `req-${id}.json`)
  const waveFile = path.join(TMP_DIR, `out-${id}.wav`)
  const resultFile = path.join(TMP_DIR, `res-${id}.json`)
  try {
    fs.writeFileSync(requestFile, JSON.stringify({
      text,
      voice: options.voice || '',
      rate: options.rate,
      volume: options.volume,
    }), 'utf8')
    const run = await runScript('tts.ps1', ['-Request', requestFile, '-Wave', waveFile, '-Result', resultFile], SYNTH_TIMEOUT_MS)
    let payload = null
    try { payload = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { /* 下面统一报错 */ }
    if (!payload || payload.ok === false) {
      const detail = (payload && payload.error) || (run.stderr || run.stdout || (run.err && run.err.message) || '').trim() || '合成失败'
      log('synthesize failed', detail)
      writeStatus({ host: { ...(readStatus().host || {}), sapiOk: false, error: detail, checkedAt: new Date().toISOString() } })
      return { ok: false, error: detail }
    }
    const bytes = fs.readFileSync(waveFile)
    if (!bytes.length) return { ok: false, error: '合成结果为空' }
    writeStatus({ host: { ...(readStatus().host || {}), sapiOk: true, error: '', lastVoice: payload.voice || '', checkedAt: new Date().toISOString() } })
    return { ok: true, bytes, voice: payload.voice || '' }
  } catch (e) {
    const detail = String(e?.message ?? e)
    log('synthesize threw', detail)
    return { ok: false, error: detail }
  } finally {
    for (const file of [requestFile, waveFile, resultFile]) {
      try { fs.unlinkSync(file) } catch { /* 清不掉就留给系统 */ }
    }
  }
}
function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

export default {
  name: 'dsh-voice',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const disposers = []

    /** 信任栅栏：先看 Host/Origin 是否可信，再看是否已认证（fail-closed）。 */
    function rejected(req, res) {
      let conn = null
      try { conn = ctx.get('connection') || ctx.connection } catch { conn = null }

      let trusted = isLoopbackReq(req)
      if (!trusted && conn && typeof conn.isTrusted === 'function') {
        try { trusted = conn.isTrusted(req) === true } catch { trusted = false }
      }
      if (!trusted) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }

      if (!conn || typeof conn.requestRejection !== 'function') {
        if (!rejected.warned) { rejected.warned = true; log('拒绝：connection.requestRejection 不可用（fail-closed）') }
        json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' })
        return true
      }
      try {
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (e) {
        log('拒绝：信任栅栏异常', String(e?.message ?? e))
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' })
        return true
      }
    }

    function route(pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            log('route error', pathname, String(err?.message ?? err))
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch { /* 已经发过响应 */ }
          }
        },
      }))
    }

    // 合成：客户端把一段文字发过来，拿回 WAV 字节。
    route('/dsh-voice/api/tts', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 POST' }); return }
      let body = {}
      try { body = JSON.parse(await readBody(req) || '{}') } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) { json(res, 400, { ok: false, error: 'text 不能为空' }); return }
      if (text.length > MAX_TEXT) { json(res, 413, { ok: false, error: `一次最多 ${MAX_TEXT} 字` }); return }

      const out = await synthesize(text, {
        voice: typeof body.voice === 'string' ? body.voice : '',
        rate: Number.isFinite(Number(body.rate)) ? Number(body.rate) : 0,
        volume: Number.isFinite(Number(body.volume)) ? Number(body.volume) : 100,
      })
      if (!out.ok) { json(res, 500, { ok: false, error: out.error }); return }
      res.statusCode = 200
      res.setHeader('content-type', 'audio/wav')
      res.setHeader('content-length', String(out.bytes.length))
      res.setHeader('cache-control', 'no-store')
      res.end(out.bytes)
    })

    // 音色列表：浏览器设置页用它填下拉框。
    route('/dsh-voice/api/voices', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只接受 GET' }); return }
      const result = await listVoices()
      writeStatus({
        host: {
          ...(readStatus().host || {}),
          sapiOk: result.ok,
          error: result.error || '',
          defaultVoice: result.default || '',
          voices: result.voices,
          checkedAt: new Date().toISOString(),
        },
      })
      json(res, 200, { ok: result.ok, source: 'sapi', error: result.error || '', default: result.default || '', voices: result.voices })
    })
    // 自检状态：读/写。浏览器把"它那边看到了什么"（音色数量、DOM 是否命中、报错）写进来，
    // 于是"到底哪一层哑了"可以事后查文件，而不是靠猜。
    route('/dsh-voice/api/status', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, status: readStatus() }); return }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 GET / POST' }); return }
      let body = {}
      try { body = JSON.parse(await readBody(req) || '{}') } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return }
      const current = readStatus()
      const browser = { ...(current.browser || {}), ...(body.browser && typeof body.browser === 'object' ? body.browser : {}), updatedAt: new Date().toISOString() }
      const next = writeStatus({ browser })
      json(res, 200, { ok: true, status: next })
    })

    // 启动自检：先探一次 SAPI，结果落盘。失败了也照常注册路由（客户端会自己退回浏览器音色）。
    ;(async () => {
      ensureDirs()
      log('plugin loaded')
      const result = await listVoices()
      writeStatus({
        host: {
          sapiOk: result.ok,
          error: result.error || '',
          defaultVoice: result.default || '',
          voices: result.voices,
          checkedAt: new Date().toISOString(),
        },
        runtime: {
          pid: process.pid,
          dshHome: DSH_HOME,
          execPath: process.execPath,
          startedAt: new Date().toISOString(),
        },
      })
      log('sapi probe', { ok: result.ok, voices: (result.voices || []).length, error: result.error })

      // 真合成一句存成 wav：光"能列音色"不算数，能吐出声才算。
      if (result.ok) {
        const sample = path.join(STATE_DIR, 'selftest.wav')
        const out = await synthesize('语音播报自检：听到这句话，说明声音已经通了。', { voice: '', rate: 0, volume: 100 })
        if (out.ok) {
          try {
            fs.writeFileSync(sample, out.bytes)
            const duration = wavDuration(out.bytes)
            writeStatus({ host: { ...(readStatus().host || {}), selftest: { ok: true, file: sample, bytes: out.bytes.length, seconds: duration, voice: out.voice } } })
            log('selftest ok', { bytes: out.bytes.length, seconds: duration })
          } catch (e) {
            log('selftest write failed', String(e?.message ?? e))
          }
        } else {
          writeStatus({ host: { ...(readStatus().host || {}), selftest: { ok: false, error: out.error } } })
          log('selftest failed', out.error)
        }
      }
    })().catch((e) => log('probe threw', String(e?.message ?? e)))

    return () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch { /* 卸载失败不阻塞 */ }
      }
      log('plugin disposed')
    }
  },
}