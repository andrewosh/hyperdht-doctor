
const fastify = require('fastify')
const pino = require('pino')
const level = require('level')
const bjson = require('buffer-json-encoding')
const debounce = require('debounceify')

const Doctor = require('@hyperdht-doctor/client')

const VERSION = 'v1'
const PORT = 8080
const REFRESH_INTERVAL = 1000 * 60 * 5

const requiredHeadersSchema = {
  type: 'object',
  properties: {
    'user-agent': {
      type: 'string',
      pattern: 'hyperdht-doctor/cli'
    }
  },
  required: ['user-agent']
}
const manifestResponseSchema = {
  headers: requiredHeadersSchema,
  response: {
    200: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              publicKey: {
                type: 'string',
                minLength: 32,
                maxLength: 32
              },
              type: {
                type: 'string'
              }
            }
          }
        }
      }
    }
  }
}
const reportRequestSchema = {
  headers: requiredHeadersSchema
}

module.exports = class CoordinationServer {
  constructor (opts = {}) {
    const {
      storage,
      port = PORT,
      logger = pino(),
      config = { servers: [] },
      refreshInterval = REFRESH_INTERVAL
    } = opts

    if (!storage) throw new Error('Must provide a storage path')
    if (!config.servers) throw new Error('Malformed configuration')

    this.db = level(storage, {
      keyEncoding: 'utf-8',
      valueEncoding: bjson
    })
    this.doctor = new Doctor()
    this.destroyed = false
    this.port = port
    this.config = config

    this.server = fastify({ logger })
    this.server.get('/', { schema: manifestResponseSchema }, this._sendManifest.bind(this))
    this.server.post('/', { schema: reportRequestSchema }, this._saveReport.bind(this))

    this._logger = logger.child({
      serializers: {
        publicKey: k => k.toString('hex'),
        err: pino.stdSerializers.err
      }
    })
    this._refreshInterval = refreshInterval
    this._refresher = debounce(this._refreshManifest.bind(this))
    this._manifest = { servers: [] }
    this._timer = null

    this._opening = this._open()
    this._opening.catch(noop)

    this.ready = () => this._opening
  }

  async _open () {
    await this.db.open()
    this.server.listen(this._port)
    this._timer = setInterval(this._refresher, this._refreshInterval)
    await this._refresher()
    this._opening = null
  }

  async destroy () {
    if (this.destroyed) return
    this.destroyed = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    await this.server.close()
    await this.db.close()
    await this.doctor.destroy()
  }

  async _refreshManifest () {
    const servers = []
    for (const server of this.config.servers) {
      try {
        this._logger.info({ server: server.publicKey }, 'pinging')
        await this.doctor.ping(Buffer.from(server.publicKey, 'hex'))
        this._logger.info({ server: server.publicKey }, 'ping success')
        servers.push(server)
      } catch (err) {
        // If there was an error connecting to a server, do not distribute it to users.
        this._logger.error({ err, server: server.publicKey }, 'ping errored')
        continue
      }
    }
    this._manifest = { servers }
  }

  async _sendManifest (req, res) {
    if (this._opening) await this._opening
    return this._manifest || {}
  }

  async _saveReport (req, res) {
    this._logger.info({ report: req.body }, 'saving report')
    if (this._opening) await this._opening
    await this.db.put(VERSION + '!' + Date.now(), req.body)
    // TODO: Anything else in the response here?
    return null
  }
}

function noop () {}
