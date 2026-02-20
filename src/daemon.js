const Hyperswarm = require('hyperswarm')
const net = require('net')
const fs = require('fs')
const path = require('path')
const { deriveTopic, agentId } = require('./crypto')

const WALKIE_DIR = process.env.WALKIE_DIR || path.join(process.env.HOME, '.walkie')
const SOCKET_PATH = path.join(WALKIE_DIR, 'daemon.sock')
const PID_FILE = path.join(WALKIE_DIR, 'daemon.pid')
const LOG_FILE = path.join(WALKIE_DIR, 'daemon.log')
const LOCK_FILE = path.join(WALKIE_DIR, 'daemon.lock')

const MAX_IPC_BUFFER = 1024 * 1024       // 1MB
const MAX_PEER_BUFFER = 1024 * 1024      // 1MB
const MAX_MESSAGE_SIZE = 256 * 1024      // 256KB

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch {}
}

class WalkieDaemon {
  constructor() {
    this.id = agentId()
    this.swarm = new Hyperswarm()
    this.channels = new Map()
    this.peers = new Map()
  }

  async start() {
    fs.mkdirSync(WALKIE_DIR, { recursive: true, mode: 0o700 })

    // Advisory lock to prevent double-daemon
    try {
      this._lockFd = fs.openSync(LOCK_FILE, 'w')
      // Try non-blocking exclusive lock via flock (Node doesn't expose flock,
      // so we use the PID-check approach as fallback)
    } catch {}

    // Check for stale daemon
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10)
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0) // Check if alive
          log(`Another daemon already running pid=${oldPid}, exiting`)
          process.exit(1)
        } catch {} // Not alive, stale PID file
      }
    } catch {}

    fs.writeFileSync(PID_FILE, process.pid.toString())

    // Clean stale socket
    try { fs.unlinkSync(SOCKET_PATH) } catch {}

    // IPC server for CLI commands
    const server = net.createServer(sock => this._onIPC(sock))
    server.listen(SOCKET_PATH, () => {
      // Restrict socket to owner only
      try { fs.chmodSync(SOCKET_PATH, 0o600) } catch {}
    })

    // P2P connections
    this.swarm.on('connection', (conn, info) => this._onPeer(conn, info))

    process.on('SIGTERM', () => this.shutdown())
    process.on('SIGINT', () => this.shutdown())

    log(`Daemon started pid=${process.pid}`)
  }

  // ── IPC (CLI <-> Daemon) ──────────────────────────────────────────

  _onIPC(socket) {
    let buf = ''
    socket.on('data', data => {
      buf += data.toString()

      // Buffer overflow protection
      if (buf.length > MAX_IPC_BUFFER) {
        socket.write(JSON.stringify({ ok: false, error: 'Request too large' }) + '\n')
        socket.destroy()
        return
      }

      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.trim()) {
          try {
            this._exec(JSON.parse(line), socket)
          } catch (e) {
            socket.write(JSON.stringify({ ok: false, error: e.message }) + '\n')
          }
        }
      }
    })
    socket.on('error', () => {})
  }

  async _exec(cmd, socket) {
    const reply = d => socket.write(JSON.stringify(d) + '\n')

    try {
      switch (cmd.action) {
        case 'join': {
          await this._joinChannel(cmd.channel, cmd.secret)
          reply({ ok: true, channel: cmd.channel })
          break
        }
        case 'send': {
          // Message size limit
          if (cmd.message && Buffer.byteLength(cmd.message) > MAX_MESSAGE_SIZE) {
            reply({ ok: false, error: `Message too large (max ${MAX_MESSAGE_SIZE / 1024}KB)` })
            return
          }
          const count = this._send(cmd.channel, cmd.message)
          reply({ ok: true, delivered: count })
          break
        }
        case 'read': {
          const ch = this.channels.get(cmd.channel)
          if (!ch) { reply({ ok: false, error: `Not in channel: ${cmd.channel}` }); return }

          if (ch.messages.length > 0 || !cmd.wait) {
            reply({ ok: true, messages: ch.messages.splice(0) })
            return
          }

          const timeout = (cmd.timeout || 30) * 1000
          const timer = setTimeout(() => {
            ch.waiters = ch.waiters.filter(w => w !== waiter)
            reply({ ok: true, messages: [] })
          }, timeout)

          const waiter = (msgs) => {
            clearTimeout(timer)
            reply({ ok: true, messages: msgs })
          }
          ch.waiters.push(waiter)
          break
        }
        case 'leave': {
          await this._leaveChannel(cmd.channel)
          reply({ ok: true })
          break
        }
        case 'status': {
          const channels = {}
          for (const [name, ch] of this.channels) {
            channels[name] = { peers: ch.peers.size, buffered: ch.messages.length }
          }
          reply({ ok: true, channels, daemonId: this.id })
          break
        }
        case 'ping': {
          reply({ ok: true })
          break
        }
        case 'stop': {
          reply({ ok: true })
          await this.shutdown()
          break
        }
        default:
          reply({ ok: false, error: `Unknown action: ${cmd.action}` })
      }
    } catch (e) {
      reply({ ok: false, error: e.message })
    }
  }

  // ── Channel management ────────────────────────────────────────────

  async _joinChannel(name, secret) {
    if (this.channels.has(name)) return

    const topic = deriveTopic(name, secret)
    const topicHex = topic.toString('hex')
    log(`Joining topic=${topicHex.slice(0, 16)}...`)
    const discovery = this.swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    log(`Topic ${topicHex.slice(0, 16)} flushed, discoverable`)

    this.channels.set(name, {
      topicHex,
      discovery,
      peers: new Set(),
      messages: [],
      waiters: []
    })

    this._reannounce()
  }

  _reannounce() {
    const topics = Array.from(this.channels.values()).map(ch => ch.topicHex)
    const hello = JSON.stringify({ t: 'hello', topics, id: this.id }) + '\n'
    for (const [remoteKey, peer] of this.peers) {
      if (peer.conn?.writable) {
        log(`Re-announcing ${topics.length} topic(s) to peer ${remoteKey.slice(0, 8)}`)
        peer.conn.write(hello)
      }
      if (peer.knownTopics) {
        for (const [, ch] of this.channels) {
          if (peer.knownTopics.has(ch.topicHex) && !ch.peers.has(remoteKey)) {
            ch.peers.add(remoteKey)
            peer.channels.add(ch.topicHex.slice(0, 8))
            log(`Late-matched topic ${ch.topicHex.slice(0, 8)} with peer ${remoteKey.slice(0, 8)}`)
          }
        }
      }
    }
  }

  async _leaveChannel(name) {
    const ch = this.channels.get(name)
    if (!ch) return
    await ch.discovery.destroy()
    this.channels.delete(name)
  }

  // ── P2P peer handling ─────────────────────────────────────────────

  _onPeer(conn, info) {
    const remoteKey = conn.remotePublicKey.toString('hex')
    log(`Peer connected: ${remoteKey.slice(0, 8)}`)

    const peer = { conn, channels: new Set(), buf: '' }
    this.peers.set(remoteKey, peer)

    const topics = Array.from(this.channels.values()).map(ch => ch.topicHex)
    conn.write(JSON.stringify({ t: 'hello', topics, id: this.id }) + '\n')

    conn.on('data', data => {
      peer.buf += data.toString()

      // Buffer overflow protection — disconnect abusive peer
      if (peer.buf.length > MAX_PEER_BUFFER) {
        log(`Peer ${remoteKey.slice(0, 8)} exceeded buffer limit, disconnecting`)
        conn.destroy()
        return
      }

      let idx
      while ((idx = peer.buf.indexOf('\n')) !== -1) {
        const line = peer.buf.slice(0, idx)
        peer.buf = peer.buf.slice(idx + 1)
        if (line.trim()) {
          try { this._onPeerMsg(remoteKey, JSON.parse(line)) } catch {}
        }
      }
    })

    conn.on('close', () => {
      for (const [, ch] of this.channels) ch.peers.delete(remoteKey)
      this.peers.delete(remoteKey)
    })

    conn.on('error', () => conn.destroy())
  }

  _onPeerMsg(remoteKey, msg) {
    const peer = this.peers.get(remoteKey)
    if (!peer) return

    if (msg.t === 'hello') {
      const theirTopics = new Set(msg.topics || [])
      peer.knownTopics = theirTopics
      log(`Hello from peer ${remoteKey.slice(0, 8)} with ${theirTopics.size} topic(s)`)
      for (const [, ch] of this.channels) {
        if (theirTopics.has(ch.topicHex) && !ch.peers.has(remoteKey)) {
          ch.peers.add(remoteKey)
          peer.channels.add(ch.topicHex.slice(0, 8))
          log(`Matched topic ${ch.topicHex.slice(0, 8)} with peer ${remoteKey.slice(0, 8)}`)
        }
      }
      return
    }

    if (msg.t === 'msg') {
      // Message size check from peer
      if (msg.data && Buffer.byteLength(msg.data) > MAX_MESSAGE_SIZE) {
        log(`Dropped oversized message from peer ${remoteKey.slice(0, 8)}`)
        return
      }

      for (const [, ch] of this.channels) {
        if (ch.topicHex === msg.topic) {
          const entry = { from: msg.id || remoteKey.slice(0, 8), data: msg.data, ts: msg.ts }

          if (ch.waiters.length > 0) {
            const waiter = ch.waiters.shift()
            waiter([entry])
          } else {
            ch.messages.push(entry)
          }
          break
        }
      }
    }
  }

  // ── Send ──────────────────────────────────────────────────────────

  _send(channelName, message) {
    const ch = this.channels.get(channelName)
    if (!ch) throw new Error(`Not in channel: ${channelName}`)

    const payload = JSON.stringify({
      t: 'msg',
      topic: ch.topicHex,
      data: message,
      id: this.id,
      ts: Date.now()
    }) + '\n'

    let count = 0
    for (const remoteKey of ch.peers) {
      const peer = this.peers.get(remoteKey)
      if (peer?.conn?.writable) {
        peer.conn.write(payload)
        count++
      }
    }
    return count
  }

  // ── Shutdown ──────────────────────────────────────────────────────

  async shutdown() {
    try { fs.unlinkSync(SOCKET_PATH) } catch {}
    try { fs.unlinkSync(PID_FILE) } catch {}
    if (this._lockFd != null) {
      try { fs.closeSync(this._lockFd) } catch {}
    }
    try { fs.unlinkSync(LOCK_FILE) } catch {}
    await this.swarm.destroy()
    process.exit(0)
  }
}

const daemon = new WalkieDaemon()
daemon.start().catch(e => {
  console.error('Failed to start daemon:', e.message)
  process.exit(1)
})
