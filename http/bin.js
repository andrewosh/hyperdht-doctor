#!/usr/bin/env node

const p = require('path')
const fs = require('fs')

const CoordinationServer = require('.')

start()

async function start () {
  const server = new CoordinationServer({
    config: JSON.parse(await fs.promises.readFile(process.env.CONFIG || p.join(__dirname, 'config.json'), { encoding: 'utf-8' })),
    storage: process.env.STORAGE || p.join(__dirname, 'storage'),
    port: +process.env.PORT || 8080
  })

  process.on('SIGINT', () => server.destroy())
  process.on('SIGTERM', () => server.destroy())

  await server.ready()
}
