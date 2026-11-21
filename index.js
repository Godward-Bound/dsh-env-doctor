/**
 * dsh-env-doctor —— 环境自检
 *
 * Host-only：无界面，只给 agent 一个工具 env_doctor。
 * 一次调用回答：常驻端口活没活（PID/进程名/启动时间）、磁盘剩多少、
 * Temp 下 dsh-* 快照占多大、当前会话轮数与 token 消耗。
 *
 * 设计约束：
 *   · 零 npm 依赖，只用 node:fs / node:fs/promises / node:child_process / node:path / node:os
 *   · 子进程全部带超时；单次调用总耗时 < 5 秒（ports 与 disk 并行）
 *   · 只读，不改系统任何东西
 *   · 返回给模型的 report ≤ 4KB，完整数据放 detail
 *   · session 拿不到的字段标 UNKNOWN 并写明原因——不估、不编
 *
 * Config 思路：宿主的 Schemastery 能加载就导出 Config（面板可改），加载失败就
 * undefined——一切走 patch config 与 DEFAULTS，功能不降级。用户路径集中在
 * DEFAULTS，代码里不散落；默认值全部通用（不预置任何个人端口/路径）。
 */

import { execFile } from 'node:child_process'
import { statfsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, sep } from 'node:path'

export const name = 'dsh-env-doctor'

/* ───────────── 默认配置（用户路径集中在这里） ───────────── */

const DEFAULTS = {
  /** 要体检的端口清单。默认不猜端口：空清单时工具返回「怎么配 ports」的引导，
   *  不崩、不返回空表。在本机 profile 的 cordis.patch.yml 或实例 config 里配。 */
  ports: [],
  drives: ['C:', 'D:', 'E:', 'F:'],
  /** Temp 根：DSH 快照病灶在这里。留空 = 运行时取 os.tmpdir()；
   *  若结果路径里含 dsh-（DSH 会把子进程的 TEMP 重定向到自己的私有目录），
   *  退回 %LOCALAPPDATA%\Temp（见 resolveTempDir）。 */
  tempDir: '',
  snapshotPrefix: 'dsh-',
  /** SurfCore 遥测目录：session 用量的数据源。留空 = session 段恒 UNKNOWN（不报错）。 */
  surfcoreStateDir: '',
  /** 递归扫描的文件数防御上限（正常机器的 Temp 远触不到） */
  scanFileCap: 200000,
  /** 子进程超时（ms）。实测：netstat ~50ms 稳；wmic 定点查 ~0.9s；
   *  PowerShell 波动大（闲 2.9s、忙 >6s）已弃用；tasklist 全表 ~2.3s，仅作 wmic 失败时的名字兜底。
   *  最坏路径 ≈ 1.2s(netstat) + 2.2s(并行取 max) ≈ 3.4s < 5s 总预算。 */
  netstatTimeoutMs: 1200,
  tasklistTimeoutMs: 2200,
  procTimeoutMs: 2000,
}

/** 解析 Temp 根（口径见 DEFAULTS.tempDir 注释）：显式配置优先；其次 os.tmpdir()；
 *  命中 DSH 的私有 TEMP 重定向（路径里含 dsh-）时退回 %LOCALAPPDATA%\Temp。 */
function resolveTempDir(cfg) {
  const explicit = String(cfg.tempDir ?? '').trim()
  if (explicit) return explicit
  const sys = tmpdir()
  if (!sys.includes('dsh-')) return sys
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData\\Local'), 'Temp')
}

/* ───────────── Config（Schemastery，宿主包兜底加载） ───────────── */

/** 由当前进程推断宿主 node_modules 候选根（宿主插件的通用兜底策略）。 */
function candidateRoots() {
  const out = []
  const seen = new Set()
  const push = (p) => {
    if (!p) return
    const k = p.replace(/\\/g, '/').toLowerCase()
    if (!seen.has(k)) { seen.add(k); out.push(p) }
  }
  try {
    const exe = process.execPath.replace(/\\/g, '/')
    const dir = exe.slice(0, exe.lastIndexOf('/'))
    push(`${dir}/resources/app.asar/dsh/node_modules`)
    push(`${dir}/resources/app/dsh/node_modules`)
    push(`${dir}/../resources/app/dsh/node_modules`)
    push(`${dir}/node_modules`)
  } catch { /* 推断失败就只用 bare import */ }
  return out
}

async function loadSchemastery() {
  try {
    const m = await import('@deepseek-ai/schemastery')
    return m.default ?? m
  } catch { /* 走候选根 */ }
  for (const root of candidateRoots()) {
    for (const entry of ['lib/index.js', 'dist/index.mjs', 'index.js']) {
      try {
        const m = await import(`file://${root}/@deepseek-ai/schemastery/${entry}`)
        return m.default ?? m
      } catch { /* 下一个 */ }
    }
  }
  return null
}

const z = await loadSchemastery()

export const Config = z
  ? z.object({
      ports: z.array(z.number()).default(DEFAULTS.ports),
      drives: z.array(z.string()).default(DEFAULTS.drives),
      tempDir: z.string().default(DEFAULTS.tempDir),
      snapshotPrefix: z.string().default(DEFAULTS.snapshotPrefix),
      surfcoreStateDir: z.string().default(DEFAULTS.surfcoreStateDir),
      scanFileCap: z.number().default(DEFAULTS.scanFileCap),
    })
  : undefined

/* ───────────── 子进程封装（全部带超时） ───────────── */

const run = (cmd, args, timeoutMs, maxBuffer = 32 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout ?? ''))
    })
  })

/** 解析 netstat -ano 的 LISTENING 行：port -> pid（同端口 v4/v6 去重）。 */
function parseNetstatListeners(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cols = line.trim().split(/\s+/)
    const local = cols[1] ?? ''
    const port = Number(local.split(':').pop())
    const pid = Number(cols[cols.length - 1])
    if (Number.isFinite(port) && Number.isFinite(pid) && pid > 0 && !map.has(port)) map.set(port, pid)
  }
  return map
}

/** 定点查进程名与启动时间：wmic 一次调用全拿到（实测 ~0.9s，远快于 PowerShell 的 3~6s）。
 *  输出 CSV：`Node,CreationDate,Name,ProcessId`；CreationDate 形如 20261121020809.636463+480，
 *  前 14 位是本地时间（+480 = UTC+8 偏移说明），与 PS 的 StartTime 交叉验证过一致。 */
async function procInfo(pids, timeoutMs) {
  const text = await run('wmic', [
    'process', 'where', pids.map((id) => `ProcessId=${id}`).join(' or '),
    'get', 'ProcessId,Name,CreationDate', '/format:csv',
  ], timeoutMs)
  const map = new Map()
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return map
  // wmic 的 CSV 列按字母序排（Node,CreationDate,Name,ProcessId），按表头定位更稳。
  const header = lines[0].split(',').map((c) => c.trim().toLowerCase())
  const ix = (name) => header.indexOf(name)
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map((c) => c.trim())
    const pid = Number(cols[ix('processid')])
    if (!Number.isFinite(pid) || !pid) continue
    let start = null
    const mt = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(cols[ix('creationdate')] ?? '')
    if (mt) start = `${mt[1]}-${mt[2]}-${mt[3]} ${mt[4]}:${mt[5]}:${mt[6]}（本地）`
    map.set(pid, { name: String(cols[ix('name')] ?? '').replace(/\.exe$/i, ''), start })
  }
  return map
}

/** tasklist 兜底：只有进程名，没有启动时间。 */
async function tasklistNames(timeoutMs) {
  const text = await run('tasklist', ['/fo', 'csv', '/nh'], timeoutMs)
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/)
    if (m) map.set(Number(m[2]), { name: m[1], start: null })
  }
  return map
}

/* ───────────── ports ───────────── */

/**
 * 探测端口清单。返回 { rows, psError }：
 * 每行 { port, listening, pid?, name?, start?, note? }；
 * 启动时间拿不到就 'UNKNOWN'，原因写在该行 note 里。
 */
export async function probePorts(cfg) {
  let map
  try {
    map = parseNetstatListeners(await run('netstat', ['-ano', '-p', 'TCP'], cfg.netstatTimeoutMs))
  } catch (e) {
    return { error: `netstat 失败：${e.message ?? e}`, rows: [] }
  }
  const listening = cfg.ports.filter((p) => map.has(p))
  let infos = new Map()
  let psError = null
  let nameSource = null
  if (listening.length) {
    const pids = [...new Set(listening.map((p) => map.get(p)))]
    // wmic（~0.9s，名字+启动时间）先行；失败才退 tasklist（~2.3s 全表，只有名字）。
    try {
      infos = await procInfo(pids, cfg.procTimeoutMs)
      if (infos.size) nameSource = 'wmic'
    } catch (e) {
      psError = String(e.message ?? e)
    }
    if (!infos.size) {
      try { infos = await tasklistNames(cfg.tasklistTimeoutMs) } catch { /* 名字也拿不到 → UNKNOWN */ }
      if (infos.size) nameSource = 'tasklist'
    }
  }
  const rows = cfg.ports.map((p) => {
    if (!map.has(p)) return { port: p, listening: false }
    const pid = map.get(p)
    const info = infos.get(pid)
    const unknownNote = psError
      ? 'UNKNOWN（wmic 进程查询超时/失败，启动时间拿不到）'
      : (info && info.start == null ? 'UNKNOWN（该进程拿不到创建时间）' : '')
    return {
      port: p,
      listening: true,
      pid,
      name: info?.name || 'UNKNOWN',
      start: info?.start || unknownNote || 'UNKNOWN',
      nameSource: info?.start ? undefined : nameSource,
    }
  })
  return { rows, psError: psError ?? undefined }
}

/* ───────────── disk ───────────── */

/** 单个条目的递归大小；全局文件数上限，触顶后停止扩张（口径标注 partial）。 */
function makeDupper(cap) {
  let files = 0
  let capped = false
  // 每层的文件 stat 并发（串行 await 7k+ 次实测 >3s，是整条链的瓶颈）；子目录递归保持串行控深度。
  const du = async (dir, depth) => {
    if (capped || depth > 12) return 0
    let list
    try { list = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
    const subDirs = []
    const sizes = await Promise.all(list.map(async (it) => {
      const p = join(dir, it.name)
      if (it.isDirectory()) { subDirs.push(p); return 0 }
      files++
      try { return (await stat(p)).size } catch { return 0 }
    }))
    let sum = sizes.reduce((a, b) => a + b, 0)
    if (files >= cap) { capped = true; return sum }
    for (const p of subDirs) {
      sum += await du(p, depth + 1)
      if (capped) break
    }
    return sum
  }
  return { du, capped: () => capped, files: () => files }
}

/**
 * 磁盘体检。返回 { drives, temp }：
 * temp 含 totalBytes / items / snapshotCount / snapshotBytes / top5 / partial。
 */
export async function scanDisk(cfg) {
  const drives = []
  for (const d of cfg.drives) {
    try {
      const s = statfsSync(d + sep)
      const totalGb = (s.blocks * s.bsize) / 2 ** 30
      const freeGb = (s.bfree * s.bsize) / 2 ** 30
      drives.push({ drive: d, totalGb: +totalGb.toFixed(1), freeGb: +freeGb.toFixed(1), freePct: `${Math.round((freeGb / totalGb) * 100)}%` })
    } catch (e) {
      drives.push({ drive: d, error: String(e.code ?? e.message ?? e) })
    }
  }
  const tempRoot = resolveTempDir(cfg)
  const temp = { dir: tempRoot }
  let entries
  try {
    entries = await readdir(tempRoot, { withFileTypes: true })
  } catch (e) {
    temp.error = String(e.code ?? e.message ?? e)
    return { drives, temp }
  }
  const { du, capped, files } = makeDupper(cfg.scanFileCap)
  const items = []
  for (const e of entries) {
    const p = join(tempRoot, e.name)
    let sizeBytes = 0
    if (e.isDirectory()) sizeBytes = await du(p, 0)
    else { try { sizeBytes = (await stat(p)).size } catch { /* 跳过 */ } }
    items.push({
      name: e.name,
      isDir: e.isDirectory(),
      sizeBytes,
      snapshot: e.isDirectory() && e.name.startsWith(cfg.snapshotPrefix),
    })
  }
  const snapshots = items.filter((i) => i.snapshot)
  temp.totalBytes = items.reduce((s, i) => s + i.sizeBytes, 0)
  temp.items = items.length
  temp.scannedFiles = files()
  temp.partial = capped()
  temp.snapshotCount = snapshots.length
  temp.snapshotBytes = snapshots.reduce((s, i) => s + i.sizeBytes, 0)
  temp.top5 = [...items].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 5)
    .map((i) => ({ name: i.name, sizeBytes: i.sizeBytes }))
  return { drives, temp }
}

/* ───────────── session ───────────── */

/**
 * 当前会话用量。数据源：SurfCore 遥测（token-usage.jsonl，b 是每次上报的增量）。
 * 拿不到的字段一律 'UNKNOWN' + 原因，不估、不编。
 */
export function scanSession(cfg, exec) {
  const sidSource = exec?.sessionId ? 'exec.sessionId' : (exec?.agent?.id ? 'exec.agent.id' : null)
  const sid = sidSource ? String(exec?.sessionId ?? exec?.agent?.id) : ''
  const out = {
    sessionId: sid || 'UNKNOWN',
    sessionIdFrom: sidSource ?? '工具执行上下文里没有会话标识字段（exec.sessionId / exec.agent.id 都是空）',
  }
  if (!sid) {
    out.turns = 'UNKNOWN'
    out.tokens = 'UNKNOWN'
    out.reason = 'exec 上下文里拿不到 sessionId，无法在遥测里定位本会话'
    return out
  }
  if (!String(cfg.surfcoreStateDir ?? '').trim()) {
    out.turns = 'UNKNOWN'
    out.tokens = 'UNKNOWN'
    out.reason = '未配置 surfcoreStateDir——session 段需要 SurfCore 遥测目录（config.surfcoreStateDir），没配就恒 UNKNOWN'
    return out
  }
  const needle = `"sid":"${sid}"`
  let turns = 0
  const b = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  let lastTs = 0
  let hit = false
  let text = ''
  try {
    text = readFileSync(join(cfg.surfcoreStateDir, 'token-usage.jsonl'), 'utf8')
  } catch (e) {
    out.turns = 'UNKNOWN'
    out.tokens = 'UNKNOWN'
    out.reason = `遥测读取失败：${String(e.code ?? e.message ?? e)}`
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j?.sid !== sid) continue
    hit = true
    if (j.k === 'turn') turns = Math.max(turns, Number(j.turn) || 0)
    for (const key of Object.keys(b)) b[key] += Number(j.b?.[key]) || 0
    lastTs = Math.max(lastTs, Number(j.t) || 0)
  }
  if (!hit) {
    out.turns = 'UNKNOWN'
    out.tokens = 'UNKNOWN'
    out.reason = `遥测（token-usage.jsonl）里没有本会话（${sid}）的行——本会话可能不走 SurfCore 桥接遥测`
    return out
  }
  out.turns = turns
  out.tokens = b
  out.tokensNote = 'b 为每次上报的增量，按 sid 求和（非累计口径）'
  out.lastReportAt = new Date(lastTs).toISOString()
  return out
}

/* ───────────── 报告渲染 ───────────── */

const MB = (n) => (n >= 1024 * 1024 * 1024 ? `${(n / 2 ** 30).toFixed(2)}G` : `${(n / 1024 / 1024).toFixed(1)}M`)

/** 组装 ≤4KB 的 report；detail 另附完整 JSON。 */
export function buildReport({ ports, disk, session, elapsedMs, generatedAt }) {
  const lines = []
  lines.push(`【环境自检】${generatedAt}（耗时 ${(elapsedMs / 1000).toFixed(1)}s）`)
  if (ports?.disabled) {
    lines.push('— 端口：未配置 ports（Config.ports 为空）。')
    lines.push('  在 profile 的 cordis.patch.yml 里给本插件加 config: { ports: [3000, 8080] }，或改面板里的实例 config。')
  } else if (ports?.error) {
    lines.push(`— 端口：${ports.error}`)
  } else if (ports) {
    const alive = ports.rows.filter((r) => r.listening)
    const dead = ports.rows.filter((r) => !r.listening).map((r) => r.port)
    lines.push(`— 端口（活 ${alive.length}/${ports.rows.length}）`)
    for (const r of alive) {
      lines.push(`${r.port} ● ${r.name} pid=${r.pid} 启动=${r.start}`)
    }
    lines.push(`未监听：${dead.join(' ') || '（无）'}`)
    if (ports.psError) lines.push(`注：wmic 进程查询失败（${ports.psError.slice(0, 60)}），名字走 tasklist 兜底`)
  }
  if (disk) {
    lines.push('— 磁盘')
    for (const d of disk.drives) {
      lines.push(d.error ? `${d.drive} 读取失败：${d.error}` : `${d.drive} 总 ${d.totalGb}G / 余 ${d.freeGb}G（${d.freePct}）`)
    }
    const t = disk.temp
    if (t.error) {
      lines.push(`— Temp：读取失败 ${t.error}`)
    } else {
      lines.push(`— Temp（${t.items} 项${t.partial ? '，partial：超扫描上限，数值偏小' : ''}）：合计 ${MB(t.totalBytes)}；dsh-* 快照 ${t.snapshotCount} 个 / ${MB(t.snapshotBytes)}`)
      const top = t.top5.map((i) => `${i.name} ${MB(i.sizeBytes)}`).join('、')
      lines.push(`最大 5 项：${top}`)
    }
  }
  if (session) {
    lines.push('— 本会话')
    lines.push(`sessionId=${session.sessionId}（来自 ${session.sessionIdFrom}）`)
    if (session.turns === 'UNKNOWN') {
      lines.push(`轮数/token：UNKNOWN —— ${session.reason ?? ''}`)
    } else {
      const b = session.tokens
      lines.push(`轮数 ${session.turns}；token：入(未缓存) ${b.cacheMiss} / 缓存读 ${b.cacheHit} / 缓存写 ${b.cacheWrite} / 出 ${b.output} / 推理 ${b.reasoning}（增量求和口径，末次上报 ${session.lastReportAt}）`)
    }
  }
  let text = lines.join('\n')
  const LIMIT = 4096
  if (text.length > LIMIT) text = `${text.slice(0, LIMIT - 40)}\n…（超 ${LIMIT}B 已截断，完整数据在 detail）`
  return text
}

/* ───────────── 插件入口 ───────────── */

export function apply(root, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  root.inject(['tools'], (ctx) => {
    ctx.tools.register({
      name: 'env_doctor',
      description:
        '查这台机器的现状：常驻端口活没活（PID/进程名/启动时间）、磁盘剩多少、Temp 下 dsh-* 快照占多大、当前会话轮数与 token 消耗。'
        + '拿不到的字段标 UNKNOWN 并写明原因，不估不编。',
      parameters: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            enum: ['ports', 'disk', 'session', 'all'],
            description: '要查哪一类，默认 all。',
          },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['report', 'detail'],
          properties: {
            report: { type: 'string' },
            detail: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
      },
      execute: async (args, exec) => {
        const what = args?.what ?? 'all'
        const t0 = Date.now()
        const wantPorts = what === 'ports' || what === 'all'
        const wantDisk = what === 'disk' || what === 'all'
        const wantSession = what === 'session' || what === 'all'
        // ports（子进程串行链）与 disk（fs 扫描）并行；session 读 ~0.5MB 同步文件。
        const portsEmpty = wantPorts && (!Array.isArray(cfg.ports) || cfg.ports.length === 0)
        const [ports, disk] = await Promise.all([
          portsEmpty ? Promise.resolve({ disabled: true }) : (wantPorts ? probePorts(cfg) : Promise.resolve(null)),
          wantDisk ? scanDisk(cfg) : Promise.resolve(null),
        ])
        const session = wantSession ? scanSession(cfg, exec) : null
        const elapsedMs = Date.now() - t0
        const generatedAt = new Date().toISOString()
        const report = buildReport({ ports, disk, session, elapsedMs, generatedAt })
        const detail = JSON.stringify({ generatedAt, elapsedMs, ports, disk, session })
        return { report, detail }
      },
    })
  })
}
