const tape = require('tape')
const DHT = require('@hyperswarm/dht')

const Doctor = require('.')

tape('basic ping', async t => {
  const d1 = new Doctor()
  const d2 = new Doctor()

  const { keyPair } = await d1.listen()
  try {
    await d2.ping(keyPair.publicKey)
    t.pass('ping succeeded')
  } catch (err) {
    t.fail('ping should pass')
  }

  await destroy(d1, d2)
  t.end()
})

tape('simple ping with data', async t => {
  const d1 = new Doctor()
  const d2 = new Doctor()

  const { keyPair } = await d1.listen()
  try {
    const { requests, responses, hashes } = await d2.pingWithData(keyPair.publicKey)
    t.same(requests.length, 5)
    t.same(responses.length, 5)
    for (let i = 0; i < hashes.length; i++) {
      t.same(hashes[i], responses[i])
    }
  } catch (err) {
    console.log('err:', err)
    t.fail('ping with data should pass')
  }

  await destroy(d1, d2)
  t.end()
})

tape('ping with invalid responses fail', async t => {
  const d1 = new Doctor()
  const keyPair = DHT.keyPair()

  const dht = new DHT()
  const server = dht.createServer(conn => {
    conn.end('hello world')
  })
  await server.listen(keyPair)

  try {
    await d1.pingWithData(keyPair.publicKey)
    t.fail('should have thrown')
  } catch (err) {
    t.same(err.message, 'Server did not respond with enough data')
    t.same(err.info.responses.length, 1)
    t.same(err.info.hashes.length, 5)
  }

  await server.close()
  await destroy(dht, d1)
  t.end()
})

tape('ping with invalid responses fail, bad hashes', async t => {
  const d1 = new Doctor()
  const keyPair = DHT.keyPair()

  const dht = new DHT()
  const server = dht.createServer(conn => {
    for (let i = 0; i < 5; i++) conn.write('hello world')
    conn.end()
  })
  await server.listen(keyPair)

  try {
    await d1.pingWithData(keyPair.publicKey)
    t.fail('should have thrown')
  } catch (err) {
    t.same(err.message, 'Server responded with invalid data')
    t.same(err.info.responses.length, 5)
    t.same(err.info.hashes.length, 5)
  }

  await server.close()
  await destroy(dht, d1)
  t.end()
})

tape('can generate a report for a single server', async t => {
  const d1 = new Doctor()
  const d2 = new Doctor()

  const { server, keyPair } = await d2.listen()

  const report = await d1.generateServerReport(keyPair.publicKey)

  validateSuccessfulReport(t, report)

  await server.close()
  await destroy(d1, d2)
  t.end()
})

tape('can generate a report for a single server, erroring server', async t => {
  const d1 = new Doctor()
  const dht = new DHT()
  const keyPair = DHT.keyPair()

  const server = dht.createServer(conn => {
    conn.on('error', () => {})
    conn.destroy('Server error')
  })
  await server.listen(keyPair)

  const report = await d1.generateServerReport(keyPair.publicKey)

  t.true(report.firstPing.duration)
  t.false(report.firstPing.err) // Should not error here -- connected successfully
  t.true(report.pingWithData.duration)
  t.true(report.pingWithData.err) // Should error here
  for (const ping of report.manyPings) {
    t.false(ping.result)
    t.false(ping.err)
  }

  await server.close()
  await destroy(dht, d1)
  t.end()
})

tape('can generate a report from a manifest', async t => {
  const d1 = new Doctor()
  const d2 = new Doctor()
  const d3 = new Doctor()

  const { server: server1, keyPair: kp1 } = await d2.listen()
  const { server: server2, keyPair: kp2 } = await d3.listen()

  const report = await d1.generateFullReport({
    servers: [
      {
        publicKey: kp1.publicKey
      },
      {
        publicKey: kp2.publicKey
      }
    ]
  })

  t.true(report.remoteAddress)
  validateSuccessfulReport(t, report.result[kp1.publicKey.toString('hex')])
  validateSuccessfulReport(t, report.result[kp2.publicKey.toString('hex')])

  await server1.close()
  await server2.close()
  await destroy(d1, d2, d3)
  t.end()
})

function validateSuccessfulReport (t, report) {
  t.true(report.firstPing.duration)
  t.false(report.firstPing.err)
  t.true(report.pingWithData.duration)
  t.false(report.pingWithData.err)
  for (const ping of report.manyPings) {
    t.false(ping.result)
    t.false(ping.err)
  }
}

function destroy (...doctors) {
  return Promise.all(doctors.map(d => d.destroy()))
}
