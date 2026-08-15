/**
 * DSH Desktop Web 远程控制 — 认证转发器 + Cloudflare Quick Tunnel 管理。
 *
 * 架构：手机（局域网直连或经 Cloudflare 隧道）→ 本模块监听的 0.0.0.0 端口
 * → token 校验 + Host/Origin 重写 → 127.0.0.1 上的 dsh web（其 /api 浏览器
 * 信任围栏只放行回环权威，重写后即放行，deepseek-harness 无需任何改动）。
 *
 * 认证：链接携带 ?token=…；首次访问校验通过后下发 HttpOnly cookie，后续
 * 请求凭 cookie 放行。token 与开关状态持久化，重启后链接保持有效。
 * 本模块是纯 Node 模块（不依赖 electron），可被独立测试脚本驱动。
 * @module remote-control
 */

import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Cookie 名：远程访问的会话凭据。 */
const COOKIE_NAME = 'dsh_remote'
/** Cookie 有效期（秒）：30 天，之后手机需重新用带 token 的链接访问。 */
const COOKIE_MAX_AGE = 30 * 24 * 3600
/** 默认监听端口；可在面板中修改（持久化）。 */
export const DEFAULT_PORT = 61623
/** token 长度（字节）：24 字节 ≈ 32 个 base64url 字符。 */
const TOKEN_BYTES = 24
/** 隧道 URL 的域名后缀。 */
const TUNNEL_HOST_SUFFIX = '.trycloudflare.com'
/** 转发时剔除的逐跳头（RFC 7230 §6.1），避免把上游的连接语义透传出去。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * 常量时间比较；长度不同直接判否（timingSafeEqual 对长度敏感会抛错）。
 * @param a - 待比较的明文。
 * @param b - 真值。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 解析 Cookie 头为名字 → 值映射。 */
function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== 'string' || header === '') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/** 当前非回环 IPv4 地址（局域网可达的本机地址）。 */
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

/**
 * 主动网卡探测结果缓存有效期（毫秒）。探测走 PowerShell（Get-NetRoute），
 * 每次面板刷新都跑一次会拖慢交互，因此短缓存 + 后台刷新。
 */
const LAN_PROBE_CACHE_MS = 15_000

/** 生成一个强随机访问令牌。 */
export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Web 远程控制服务：一个进程内单例，管理转发器与隧道子进程。
 */
export class RemoteControl {
  /**
   * @param options - 构造参数。
   * @param options.configPath - 持久化文件路径（token/port/开关）。
   * @param options.cloudflaredBin - cloudflared 可执行文件路径（缺失则公网开关报错）。
   * @param options.getHarnessTarget - () => { host, port } | null；dsh web 的回环地址。
   * @param options.sendState - (snapshot) => void；状态变化时推送（工具区刷新）。
   */
  constructor({ configPath, cloudflaredBin, getHarnessTarget, sendState }) {
    this.configPath = configPath
    this.cloudflaredBin = cloudflaredBin
    this.getHarnessTarget = getHarnessTarget
    this.sendState = sendState

    /** 持久化状态。 */
    this.token = generateToken()
    this.port = DEFAULT_PORT
    this.lanEnabled = false
    this.publicEnabled = false

    /** 运行时状态。 */
    this.proxyServer = null
    this.proxyError = null
    this.tunnelProcess = null
    this.publicUrl = null
    this.tunnelError = null
    // 启动中的转发器：setLan 与 setPublic 可能先后触发 startProxy，防重入
    // 避免同一端口二次 listen 触发 EADDRINUSE 把状态机打乱；_proxyStopping
    // 让启动中的 listen 回调在关闭请求后放弃接管。
    this._proxyStarting = false
    this._proxyStopping = false

    // 主动网卡地址（默认路由所在接口；null = 尚未探测或探测失败）。
    // 面板只展示这一个局域网链接，避免虚拟网卡/APIPA 地址造成多行"重复"。
    this.activeLan = null
    this._lanCache = null
    this._lanCacheAt = 0
    this._lanProbe = null
  }

  /** 读取持久化配置；文件缺失或损坏时保持默认（新 token）。 */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, 'utf8'))
      if (typeof parsed?.token === 'string' && parsed.token.length >= 16) this.token = parsed.token
      if (Number.isInteger(parsed?.port) && parsed.port > 0 && parsed.port <= 65535) this.port = parsed.port
      this.lanEnabled = parsed?.lanEnabled === true
      this.publicEnabled = parsed?.publicEnabled === true
    } catch {
      // 首次运行：使用默认值。
    }
  }

  /** 持久化当前配置（best-effort，失败不影响运行）。 */
  async persist() {
    try {
      await mkdir(path.dirname(this.configPath), { recursive: true })
      await writeFile(this.configPath, JSON.stringify({
        token: this.token,
        port: this.port,
        lanEnabled: this.lanEnabled,
        publicEnabled: this.publicEnabled,
      }, null, 2), 'utf8')
    } catch {
      // 持久化失败仅意味着下次启动回到默认配置。
    }
  }

  /** 当前状态的完整快照（工具区渲染用）。 */
  snapshot() {
    const target = this.getHarnessTarget()
    const lan = lanAddresses()
    // 主链接优先用活动网卡；未探测到时退回第一个非 APIPA 地址（169.254.x.x
    // 是链路本地自动地址，从不适合做局域网访问目标）。
    const usable = this.activeLan ?? lan.find((ip) => !ip.startsWith('169.254.')) ?? lan[0] ?? null
    return {
      token: this.token,
      port: this.port,
      lanEnabled: this.lanEnabled,
      publicEnabled: this.publicEnabled,
      proxyActive: this.proxyServer !== null,
      proxyError: this.proxyError,
      tunnelActive: this.tunnelProcess !== null,
      tunnelError: this.tunnelError,
      publicUrl: this.publicUrl,
      lanAddresses: lan,
      lanAddress: usable,
      lanUrls: usable === null ? [] : [`http://${usable}:${this.port}`],
      harnessReady: target !== null,
      harnessPort: target?.port ?? null,
    }
  }

  /** 推送一次状态快照（存在注册的发送器时）。 */
  pushState() {
    try {
      this.sendState?.(this.snapshot())
    } catch {
      // 推送失败（窗口已销毁等）不影响服务本身。
    }
  }

  // ---------- 主动网卡探测 ----------

  /**
   * 探测默认路由所在接口的 IPv4 地址（带短缓存 + 并发去重）。Windows 上
   * 虚拟网卡（VMware/VirtualBox/Hyper-V）与 APIPA 地址从不拥有默认路由，
   * 因此这是"哪个网卡真正连着网络"的可靠判据。
   * @returns 地址字符串，失败时 null。
   */
  async activeLanAddress() {
    const now = Date.now()
    if (this._lanCache !== null && now - this._lanCacheAt < LAN_PROBE_CACHE_MS) return this._lanCache
    if (this._lanProbe !== null) return this._lanProbe
    this._lanProbe = this.probeActiveLan().finally(() => { this._lanProbe = null })
    const result = await this._lanProbe
    if (result !== null) {
      this._lanCache = result
      this._lanCacheAt = now
    }
    return result
  }

  /**
   * 实际探测（无缓存）。Windows 查默认路由接口的 IP；其他平台或失败时
   * 退回第一个非 APIPA 地址。
   */
  async probeActiveLan() {
    if (process.platform === 'win32') {
      try {
        const ps = "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1; if ($null -ne $r) { (Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress }"
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
          timeout: 5_000,
        })
        const ip = String(stdout).trim()
        if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(ip)) return ip
      } catch {
        // 探测失败（PowerShell 缺失/被策略禁用等）落到启发式回退。
      }
    }
    const lan = lanAddresses()
    return lan.find((ip) => !ip.startsWith('169.254.')) ?? null
  }

  /**
   * 后台探测活动网卡并更新快照；已探测且未过期时立即返回当前值。
   * @param force - true 时忽略缓存强制重新探测（面板「刷新链接」）。
   * @returns 当前活动地址（可能为 null）。
   */
  async probeLan(force = false) {
    if (force) {
      this._lanCache = null
      this._lanCacheAt = 0
    }
    const addr = await this.activeLanAddress()
    if (addr !== null && addr !== this.activeLan) {
      this.activeLan = addr
      this.pushState()
    }
    return this.activeLan
  }

  /** 启动时恢复上次的开关状态（在 dsh web 就绪后调用）。 */
  async restore() {
    await this.load()
    if (this.lanEnabled) this.startProxy()
    if (this.publicEnabled) {
      this.startProxy()
      this.startTunnel()
    }
    void this.probeLan()
    this.pushState()
  }

  // ---------- 局域网转发器 ----------

  /** 开启局域网转发器（幂等；已在运行或启动中则无操作）。 */
  startProxy() {
    if (this.proxyServer !== null || this._proxyStarting) return
    this._proxyStarting = true
    this._proxyStopping = false
    const server = http.createServer((req, res) => this.handleRequest(req, res))
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    server.on('error', (error) => {
      this._proxyStarting = false
      this.proxyServer = null
      this.proxyError = error instanceof Error ? error.message : String(error)
      this.lanEnabled = false
      void this.persist()
      this.pushState()
    })
    server.listen(this.port, '0.0.0.0', () => {
      this._proxyStarting = false
      if (this._proxyStopping) {
        server.close(() => {})
        return
      }
      this.proxyServer = server
      this.proxyError = null
      this.lanEnabled = true
      void this.persist()
      this.pushState()
    })
  }

  /** 关闭局域网转发器。 */
  stopProxy() {
    this._proxyStopping = true
    if (this.proxyServer === null) {
      this.lanEnabled = false
      void this.persist()
      this.pushState()
      return
    }
    const server = this.proxyServer
    this.proxyServer = null
    server.close(() => {})
    this.lanEnabled = false
    void this.persist()
    this.pushState()
  }

  // ---------- 认证 ----------

  /**
   * 请求是否携带有效凭据：cookie 或 ?token= 均可（常量时间比较）。
   * @param req - 入站请求（含 headers 与 url）。
   */
  authorize(req) {
    const cookies = parseCookies(req.headers.cookie)
    if (typeof cookies[COOKIE_NAME] === 'string' && safeEqual(cookies[COOKIE_NAME], this.token)) return true
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const queryToken = url.searchParams.get('token')
      if (queryToken !== null && safeEqual(queryToken, this.token)) return true
    } catch {
      // 非法 URL 按未授权处理。
    }
    return false
  }

  /** dsh web 的回环目标（未就绪时 null）。 */
  harnessTarget() {
    const target = this.getHarnessTarget()
    if (target === null) return null
    if (typeof target.host !== 'string' || target.host === '' || !Number.isInteger(target.port)) return null
    return { host: target.host, port: target.port }
  }

  /**
   * 重写转发请求头：剔除逐跳头，并把 Host 与 Origin 改写为 dsh web 的
   * 回环权威 —— /api 浏览器信任围栏只放行回环 Host，且要求 Origin 与 Host
   * 完全一致，因此两者必须同时重写。
   * @param headers - 原始请求头。
   * @param target - { host, port }。
   */
  rewriteHeaders(headers, target) {
    const out = {}
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'host' || lower === 'origin') continue
      out[key] = value
    }
    out.host = `${target.host}:${target.port}`
    out.origin = `http://${target.host}:${target.port}`
    return out
  }

  /**
   * 升级握手的头部构造：与 {@link rewriteHeaders} 相同，但保留
   * `connection` 与 `upgrade` 头 —— WebSocket 升级请求依赖它们，删除后
   * 上游会把握手当普通 GET 处理。
   * @param headers - 原始请求头。
   * @param target - { host, port }。
   */
  buildUpgradeHeaders(headers, target) {
    const out = {}
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'origin') continue
      if (HOP_BY_HOP.has(lower) && lower !== 'connection' && lower !== 'upgrade') continue
      out[key] = value
    }
    out.host = `${target.host}:${target.port}`
    out.origin = `http://${target.host}:${target.port}`
    return out
  }

  // ---------- HTTP 转发 ----------

  /**
   * 普通 HTTP 请求：认证 → 重写 → 转发。带有效 ?token= 的首次访问会
   * 下发 cookie 并 302 到去掉 token 的同一地址。
   * @param req - 入站请求。
   * @param res - 出站响应。
   */
  handleRequest(req, res) {
    const cookies = parseCookies(req.headers.cookie)
    const cookieOk = typeof cookies[COOKIE_NAME] === 'string' && safeEqual(cookies[COOKIE_NAME], this.token)
    if (!cookieOk) {
      // 带有效 ?token= 的首次访问：种下 cookie 并 302 到去掉 token 的同一地址。
      // 之后页面与 /api 请求都凭 cookie 放行，链接中的 token 不再出现在地址栏。
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const queryToken = url.searchParams.get('token')
        if (queryToken !== null && safeEqual(queryToken, this.token)) {
          url.searchParams.delete('token')
          res.writeHead(302, {
            location: url.pathname + url.search,
            'set-cookie': `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
          })
          res.end()
          return
        }
      } catch {
        // 非法 URL 落到 403。
      }
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('403 Forbidden — DSH 远程访问需要有效令牌。请在电脑端「工具区 → Web 远程控制」中查看带令牌的链接。')
      return
    }

    const target = this.harnessTarget()
    if (target === null) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('503 — DSH 服务尚未就绪，请稍后重试。')
      return
    }

    const proxy = http.request({
      host: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: this.rewriteHeaders(req.headers, target),
    })
    proxy.on('response', (proxyRes) => {
      const headers = { ...proxyRes.headers }
      for (const hop of HOP_BY_HOP) delete headers[hop]
      res.writeHead(proxyRes.statusCode, headers)
      proxyRes.pipe(res)
    })
    proxy.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('502 — 上游 DSH 服务不可达。')
    })
    req.pipe(proxy)
  }

  // ---------- WebSocket 转发 ----------

  /**
   * WebSocket 升级握手：认证后按原始字节把握手转发到上游（重写头部），
   * 之后双向管道直通。dsh web 的 events.mux / events.host 依赖此通道。
   * @param req - 入站升级请求。
   * @param socket - 入站 TCP socket。
   * @param head - 握手后已缓冲的数据。
   */
  handleUpgrade(req, socket, head) {
    if (!this.authorize(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const target = this.harnessTarget()
    if (target === null) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      return
    }
    const upstream = net.connect(target.port, target.host, () => {
      const headLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (const [key, value] of Object.entries(this.buildUpgradeHeaders(req.headers, target))) {
        headLines.push(`${key}: ${value}`)
      }
      upstream.write(headLines.join('\r\n') + '\r\n\r\n')
      if (head !== null && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }

  // ---------- 公网隧道 ----------

  /** 开启 Cloudflare Quick Tunnel（幂等）。依赖局域网转发器作为本地入口。 */
  startTunnel() {
    if (this.tunnelProcess !== null) return
    if (!existsSync(this.cloudflaredBin)) {
      this.tunnelError = '未找到 cloudflared（安装包内组件缺失）'
      this.publicEnabled = false
      void this.persist()
      this.pushState()
      return
    }
    const child = spawn(this.cloudflaredBin, [
      'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.tunnelProcess = child
    this.tunnelError = null
    this.publicUrl = null
    this.publicEnabled = true
    void this.persist()

    const consume = (chunk) => {
      const text = chunk.toString()
      // 示例输出：Your quick Tunnel has been created! Visit it at
      // (it may take some time to be reachable): https://xxx.trycloudflare.com
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u.exec(text)
      if (match !== null && this.publicUrl !== match[0]) {
        this.publicUrl = match[0]
        this.pushState()
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    child.once('error', (error) => {
      this.tunnelProcess = null
      this.tunnelError = error instanceof Error ? error.message : String(error)
      this.publicEnabled = false
      this.publicUrl = null
      void this.persist()
      this.pushState()
    })
    child.once('exit', (code) => {
      this.tunnelProcess = null
      this.publicUrl = null
      if (this.publicEnabled) {
        this.tunnelError = `cloudflared 已退出（退出码 ${String(code)}）`
        this.publicEnabled = false
        void this.persist()
        this.pushState()
      }
    })
    this.pushState()
  }

  /** 关闭 Cloudflare Quick Tunnel。 */
  stopTunnel() {
    if (this.tunnelProcess === null) return
    const child = this.tunnelProcess
    this.tunnelProcess = null
    this.publicUrl = null
    this.tunnelError = null
    this.publicEnabled = false
    void this.persist()
    try {
      child.kill()
    } catch {
      // 进程可能已退出。
    }
    this.pushState()
  }

  // ---------- 面板操作 ----------

  /** 切换局域网访问。 */
  setLan(enabled) {
    if (enabled) {
      if (this.proxyServer === null) {
        this.proxyError = null
        this.startProxy()
      } else {
        this.lanEnabled = true
        this.pushState()
      }
    } else {
      this.stopProxy()
      // 公网依赖转发器作为本地入口：关闭局域网即同时关闭公网。
      if (this.publicEnabled) this.stopTunnel()
    }
  }

  /** 切换公网访问（自动确保转发器开启）。 */
  setPublic(enabled) {
    if (enabled) {
      this.startProxy()
      this.startTunnel()
    } else {
      this.stopTunnel()
    }
  }

  /** 重新探测局域网地址并重读隧道状态（面板「刷新链接」）。 */
  refresh() {
    void this.probeLan(true)
    this.pushState()
  }

  /** 重置访问令牌：旧链接立即全部失效。 */
  async resetToken() {
    this.token = generateToken()
    await this.persist()
    this.pushState()
  }

  /** 修改监听端口（下次启动转发器时生效）。 */
  async setPort(port) {
    const next = Number(port)
    if (!Number.isInteger(next) || next <= 0 || next > 65535) return false
    if (next === this.port) return true
    const wasLan = this.lanEnabled
    const wasPublic = this.publicEnabled
    this.stopProxy()
    if (this.tunnelProcess !== null) this.stopTunnel()
    this.port = next
    await this.persist()
    if (wasLan) this.startProxy()
    if (wasPublic) this.startTunnel()
    this.pushState()
    return true
  }

  /** 释放全部资源（应用退出前调用）。 */
  dispose() {
    // 主动关闭先落状态再 kill：cloudflared 的 exit 回调看到 publicEnabled
    // 已为 false 就不会把它当作意外退出写盘（否则重启后公网不恢复）。
    if (this.tunnelProcess !== null) {
      const child = this.tunnelProcess
      this.tunnelProcess = null
      this.publicEnabled = false
      this.publicUrl = null
      this.tunnelError = null
      try { child.kill() } catch { /* 已退出 */ }
    }
    if (this.proxyServer !== null) {
      this.proxyServer.close(() => {})
      this.proxyServer = null
    }
  }
}
