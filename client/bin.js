#!/usr/bin/env node
const readline = require('readline')
const crypto = require('hypercore-crypto')
const chalk = require('chalk')
const got = require('got')
const Spinnies = require('spinnies')

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
  console.log()

  if (!didConsent.has(maybeConsented)) {
    console.log('Exiting...')
    return
  }

  const doctor = new Doctor()
  const spinnies = new Spinnies()
  await doctor.dht.ready()

  console.log('\n Your Remote Address:', doctor.dht.remoteAddress())
  console.log()

  try {
    spinnies.add('manifest', { text: 'Loading manifest' })
    const manifest = await loadManifest()
    spinnies.succeed('manifest')

    spinnies.add('tests', { text: 'Running tests' })
    const report = await runTests(spinnies, doctor, manifest)
    spinnies.succeed('tests')

    spinnies.add('submit', { text: 'Submitting report' })
    await submitReport(report)
    spinnies.succeed('submit')

    console.log('\n Test Completed! \n')
    if (args.v || args.verbose) console.log(JSON.stringify(report, null, 2))
  } catch (err) {
    spinnies.stopAll('fail')
    console.log('\n Test Failed:', err.message + '\n')
  } finally {
    await doctor.destroy()
  }


}

function loadManifest () {
  return got(args.url || MANIFEST_URL, {
    headers: {
      'user-agent': USER_AGENT
    }
  }).json()
}

function submitReport (report) {
  return got(args.url || MANIFEST_URL, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT
    },
    json: report
  })
}

async function runTests (spinnies, doctor, manifest) {
  return doctor.generateFullReport(manifest, (phase, status, name, publicKey, report) => {
    const keyString = publicKey && publicKey.toString('hex')
    const id = name + ':' + keyString
    const title = getOutputText(name, keyString)
    if (phase === 'test' && status === 'start') {
      if (title) spinnies.add(id, { text: title, indent: 2 })
    } else if (phase === 'test' && status === 'end') {
      if (!title) return
      if (report && report.err) spinnies.fail(id)
      else spinnies.succeed(id)
    }
  })

  function getOutputText (name, publicKey) {
    if (!name || !publicKey) return null
    if (name === 'first-ping') return `Attempting first connection to: ${publicKey}`
    if (name === 'ping-with-data') return `Sending data to ${publicKey}`
    if (name === 'many-pings') return `Pinging ${publicKey} several times in quick succession`
    return null
  }
}
