const crypto = require('crypto')
const pump = require('pump')
const { Transform } = require('streamx')

const DHT = require('@hyperswarm/dht')

const CHUNK_SIZES = [1, 2, 3, 4, 5].map(s => s * 1024 * 32)
const CONNECTION_TIMEOUT = 1000 * 10

module.exports = class Doctor {
  constructor (opts = {}) {
    this.dht = new DHT(opts)
    this._chunkSizes = opts.chunkSizes || CHUNK_SIZES
    this._servers = []
  }

  async _sendData (conn) {
    const requests = []
    const responses = []
    const hashes = []

    for (const size of this._chunkSizes) {
      const buf = Buffer.allocUnsafe(size).fill(Math.round(Math.random() * 1000))
      requests.push(buf)
      hashes.push(hash(buf))
    }

    for (const req of requests) {
      conn.write(req)
    }
    conn.end()

    for await (const data of conn) {
      responses.push(data)
    }

    let err = null
    if (hashes.length > responses.length) {
      err = new Error('Server did not respond with enough data')
    } else if (hashes.length < responses.length) {
      err = new Error('Server responded with too much data')
    } else {
      for (let i = 0; i < hashes.length; i++) {
        if (!hashes[i].equals(responses[i])) {
          err = new Error('Server responded with invalid data')
          break
        }
      }
    }

    const info = {
      requests,
      responses,
      hashes
    }
    if (err) err.info = info

    if (err) throw err
    return info
  }

  async ping (publicKey) {
    const conn = this.dht.connect(publicKey)
    return new Promise((resolve, reject) => {
      conn.on('open', () => {
        conn.end()
        resolve()
      })
      conn.on('error', reject)
    })
  }

  async pingWithData (publicKey) {
    const conn = this.dht.connect(publicKey)
    return new Promise((resolve, reject) => {
      conn.on('open', () => this._sendData(conn).then(resolve, reject))
      conn.on('error', reject)
    })
  }

  async generateServerReport (publicKey, onprogress = noop) {
    const keyBuf = !Buffer.isBuffer(publicKey) ? Buffer.from(publicKey, 'hex') : publicKey
    const report = {
      firstPing: null,
      pingWithData: null,
      manyPings: []
    }

    // Ping once to see if we can connect at all
    onprogress('test', 'start', 'first-ping', publicKey)
    report.firstPing = await timeAndCatch(() => this.ping(keyBuf))
    onprogress('test', 'end', 'first-ping', publicKey, report.firstPing)

    if (report.firstPing.err) {
      // If we couldn't even ping the server, skip the remaining tests
      onprogress('test', 'terminating', publicKey)
      return report
    }

    // Ping with data
    onprogress('test', 'start', 'ping-with-data', publicKey)
    const dataResult = await timeAndCatch(() => this.pingWithData(keyBuf))
    report.pingWithData = {
      err: dataResult.err,
      info: dataResult.err && dataResult.err.info ? {
        hashes: dataResult.err.info.hashes.map(h => h.toString('hex')),
        responses: dataResult.err.info.responses.map(h => h.toString('hex'))
      }: null,
      duration: dataResult.duration
    }
    onprogress('test', 'end', 'ping-with-data', publicKey, report.pingWithData)

    // Ping three times in quick succession
    onprogress('test', 'start', 'many-pings', publicKey)
    for (let i = 1; i <= 3; i++) {
      onprogress('test', 'start', 'many-pings-' + i, publicKey)
      report.manyPings.push(await timeAndCatch(() => this.ping(keyBuf)))
      onprogress('test', 'end', 'many-pings-' + i, publicKey, report.manyPings[i - 1])
    }
    onprogress('test', 'end', 'many-pings', publicKey)

    return report
  }

  async generateFullReport (manifest, onprogress = noop) {
    if (!manifest.servers || !Array.isArray(manifest.servers)) throw new Error('Malformed manifest')

    const addr = this.dht.remoteAddress()
    const start = Date.now()
    const report = {
      remoteAddress: { ...addr, type: natTypeToString(addr.type) },
      manifest,
      result: {},
      duration: null
    }

    onprogress('start')
    for (const { publicKey } of manifest.servers) {
      onprogress('start', publicKey)
      const keyString = Buffer.isBuffer(publicKey) ? publicKey.toString('hex') : publicKey
      report.result[keyString] = await this.generateServerReport(publicKey, onprogress)
      onprogress('end', publicKey)
    }
    onprogress('end')

    report.duration = Date.now() - start

    return report
  }

  async listen ({ keyPair = DHT.keyPair() } = {}) {
    const server = this.dht.createServer(conn => {
      const hasher = new Transform({
        transform: (data, cb) => cb(null, hash(data))
      })
      const timeout = setTimeout(() => {
        conn.destroy(new Error('Connection timed out'))
      }, CONNECTION_TIMEOUT)
      pump(conn, hasher, conn, () => {
        clearTimeout(timeout)
      })
    })

    await server.listen(keyPair)
    this._servers.push(server)
    server.on('close', () => this._servers.splice(this._servers.indexOf(server, 1)))

    return { server, keyPair }
  }

  async destroy () {
    for (const server of this._servers) {
      await server.close()
    }
    return this.dht.destroy()
  }
}

function hash (buf) {
  const h = crypto.createHash('sha256')
  h.update(buf)
  return h.digest()
}

async function timeAndCatch (f) {
  const obj = {}
  const start = Date.now()
  try {
    obj.result = await f()
  } catch (err) {
    obj.err = { message: err.message, stack: err.stack }
    if (err.info) obj.info = err.info
  }
  obj.duration = Date.now() - start
  return obj
}

function natTypeToString (type) {
  if (type === DHT.NAT_PORT_RANDOMIZED) return 'randomized'
  if (type === DHT.NAT_PORT_INCREMENTING) return 'incrementing'
  if (type === DHT.NAT_PORT_CONSISTENT) return 'consistent'
  if (type === DHT.NAT_OPEN) return 'open'
  return 'unknown'
}

function noop () {}
