#!/usr/bin/env node
const readline = require('readline')
const crypto = require('hypercore-crypto')
const got = require('got')
const { Listr } = require('listr2')

const DHT = require('@hyperswarm/dht')
const Doctor = require('.')

const args = require('minimist')(process.argv.slice(2))

const USER_AGENT = 'hyperdht-doctor/cli'
const MANIFEST_URL = 'https://doctor.hyperdht.org'

const usage = `
  Command usage goes here
`
const consentPrompt = `
  Thanks for helping us test the Hyperswarm DHT.

  To help us debug, this tool will send the following information to our server at doctor.hyperdht.org:
  1. Your public IP address
  2. Your NAT configuration

  Do you want to continue with the test? [N/y] `
const didConsent = new Set(['y', 'Y', 'yes', 'YES'])

start()

async function start () {
  if (args.help || args.h) return console.log(usage)
  if (args._[0] === 'serve') return serve()
  return test()
}

async function serve () {
  const doctor = new Doctor()

  let seed = args._[1]
  if (seed && seed.length !== 64) {
    console.error('Seed must be 64 hex characters')
    process.exit(1)
  }
  if (!seed) seed = crypto.randomBytes(32).toString('hex')

  const { server, keyPair } = await doctor.listen({
    keyPair: DHT.keyPair(Buffer.from(seed, 'hex'))
  })
  console.log('Doctor swarm server listening on:', keyPair.publicKey.toString('hex'), 'with seed', seed.toString('hex'))
  let destroyed = false

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  async function cleanup () {
    if (destroyed) return
    destroyed = true
    console.log('Exiting...')
    await server.close()
    await doctor.destroy()
  }
}

async function test () {
  // User consent
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  const maybeConsented = await new Promise(resolve => {
    rl.question(consentPrompt, answer => resolve(answer))
  })
  rl.close()
  if (!didConsent.has(maybeConsented)) {
    console.log('Exiting...')
    return
  }
  console.log()

  const doctor = new Doctor()

  const tasks = new Listr([
    {
      title: 'Load manifest',
      task: loadManifest
    },
    {
      title: 'Running tests',
      task: runTests
    },
    {
      title: 'Submitting report',
      task: submitReport
    }
  ], {
    ctx: {
      doctor
    },
    persisentOutput: true
  })

  try {
    await tasks.run()
  } catch (err) {
    console.error('\nCould not run the doctor:', err.message, '\n')
  } finally {
    await doctor.destroy()
  }
}

async function loadManifest (ctx) {
  ctx.manifest = await got(args.url || MANIFEST_URL, {
    headers: {
      'user-agent': USER_AGENT
    }
  }).json()
}

async function runTests (ctx, task) {
  ctx.result = await ctx.doctor.generateFullReport(ctx.manifest, (phase, status, name, ...args) => {
    let subtasks = new Map()
    if (phase === 'test' && status === 'start') {
      const publicKey = args[0]
      let subtaskFinished = null
      new Promise(resolve => {
        subtaskFinished = resolve
      })
      console.log('adding new listr')
      task.newListr([
        {
          title: titleForTest(name, publicKey),
          task: subtaskFinished
        }
      ])
      subtasks.set(name, subtaskFinished)
    } else if (phase === 'test' && status === 'end') {
      const finished = subtasks.get(name)
      if (!finished) return
      finished()
    }
  })

  function titleForTest (name, publicKey) {
    const keyString = publicKey.toString('hex')
    if (name === 'first-ping') return `Attempting first connection to: ${keyString}`
    if (name === 'ping-with-data') return `Sending data to ${keyString}`
    if (name === 'many-pings') return `Pinging ${keyString} several times in quick succession`
  }
}

async function submitReport (ctx) {
  await got(args.url || MANIFEST_URL, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT
    },
    json: ctx.result
  })
}
