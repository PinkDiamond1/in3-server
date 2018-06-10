
import { assert, expect, should } from 'chai'
import 'mocha'
import Client, { chainData, serialize, BlockData, RPCResponse, util, Proof, LogData } from 'in3'
import { TestTransport } from '../utils/transport'
import { deployChainRegistry, registerServers, deployContract } from '../../src/util/registry';
import * as tx from '../../src/util/tx'
import * as logger from 'in3/js/test/util/memoryLogger'
import { simpleEncode } from 'ethereumjs-abi'
const toHex = util.toHex
const getAddress = util.getAddress

// our test private key
const pk = '0xb903239f8543d04b5dc1ba6579132b143087c68db1b2168786408fcbce568238'


describe('ETH Standard JSON-RPC', () => {
  it('eth_blockNumber', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient()

    logger.info('3 different blocknumbers should result in the highest')

    // 3 different blocknumbers
    test.injectResponse({ method: 'eth_blockNumber' }, { result: '0x1' }, '#1') // first node says 1
    test.injectResponse({ method: 'eth_blockNumber' }, { result: '0x2' }, '#2') // second node says 4
    test.injectResponse({ method: 'eth_blockNumber' }, { result: '0x4' }, '#3') // second node says 4


    // but we also ask for 3 answers
    const result = await client.sendRPC('eth_blockNumber', [], null, { requestCount: 3 })

    // so we must get the highest one
    assert.equal(result.result, '0x4')


    // 3 different blocknumbers
    test.injectResponse({ method: 'eth_blockNumber' }, { result: '0x1' }, '#1') // first node says 1
    test.injectResponse({ method: 'eth_blockNumber' }, { result: '0x2' }, '#2') // second node says 4
    test.injectResponse({ method: 'eth_blockNumber' }, { result: '0x4' }, '#3') // second node says 4
    test.injectRandom([0, 0, 0]) // this should force him to chose the first


    // but we also ask only for one answer
    const result2 = await client.sendRPC('eth_blockNumber', [], null, { requestCount: 1 })

    // so we must get the highest one
    assert.equal(result2.result, '0x1')
  })



  it('eth_getTransactionByHash', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')
    const pk2 = await test.createAccount('0x02')

    // send 1000 wei from a to b
    const receipt = await tx.sendTransaction(test.url, {
      privateKey: pk1,
      gas: 22000,
      to: util.getAddress(pk2),
      data: '',
      value: 1000,
      confirm: true
    })

    const res = await client.sendRPC('eth_getTransactionByHash', [receipt.transactionHash], null, { keepIn3: true })
    const result = res.result as any
    assert.exists(res.in3)
    assert.exists(res.in3.proof)
    const proof = res.in3.proof as any
    assert.equal(proof.type, 'transactionProof')
    assert.exists(proof.block)


    const b = await client.sendRPC('eth_getBlockByNumber', [result.blockNumber, true], null, { keepIn3: true })
    logger.info('found Block:', b.result)
    const block = new serialize.Block(b.result)

    assert.equal('0x' + block.hash().toString('hex').toLowerCase(), (res.result as any).blockHash, 'the hash of the blockheader in the proof must be the same as the blockHash in the Transactiondata')

    // check blocknumber
    assert.equal(parseInt('0x' + block.number.toString('hex')), parseInt(result.blockNumber), 'we must use the same blocknumber as in the transactiondata')

    logger.info('result', res)


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getTransactionByHash' }, (req, re: RPCResponse) => {
        // we change a property
        (re.result as any).to = (re.result as any).from
        return re
      })
      await client.sendRPC('eth_getTransactionByHash', [receipt.transactionHash])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated transaction must fail!')
  })


  it('eth_getTransactionReceipt', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')
    const pk2 = await test.createAccount('0x02')

    // check deployed code
    const adr = await deployContract('TestContract', pk1)
    const receipt = await tx.callContract('http://localhost:8545', adr, 'increase()', [], {
      confirm: true,
      privateKey: pk1,
      gas: 3000000,
      value: 0
    })

    assert.equal(receipt.logs.length, 1)


    const res = await client.sendRPC('eth_getTransactionReceipt', [receipt.transactionHash], null, { keepIn3: true })
    const result = res.result as any
    assert.exists(res.in3)
    assert.exists(res.in3.proof)
    const proof = res.in3.proof as any
    assert.equal(proof.type, 'receiptProof')
    assert.exists(proof.block)


    const b = await client.sendRPC('eth_getBlockByNumber', [result.blockNumber, true], null, { keepIn3: true })
    logger.info('found Block:', b.result)
    const block = new serialize.Block(b.result)

    assert.equal('0x' + block.hash().toString('hex').toLowerCase(), (res.result as any).blockHash, 'the hash of the blockheader in the proof must be the same as the blockHash in the Transactiondata')

    // check blocknumber
    assert.equal(parseInt('0x' + block.number.toString('hex')), parseInt(result.blockNumber), 'we must use the same blocknumber as in the transactiondata')

    logger.info('result', res)


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getTransactionReceipt' }, (req, re: RPCResponse) => {
        // we change a property
        (re.result as any).cumulativeGasUsed += '00'
        return re
      })
      await client.sendRPC('eth_getTransactionReceipt', [receipt.transactionHash])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated transaction must fail!')
  })




  it('eth_getBlockByNumber', async () => {
    const test = new TestTransport(1) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // send 1000 wei from a to b
    const receipt = await tx.sendTransaction(test.url, {
      privateKey: pk1,
      gas: 22000,
      to: pk1.substr(0, 42), // any address, we just need a simple transaction in the last block
      data: '',
      value: 1000,
      confirm: true
    })

    // get the last Block
    const b1 = await client.sendRPC('eth_getBlockByNumber', ['latest', false], null, { keepIn3: true })

    const result1 = b1.result as BlockData
    assert.exists(b1.in3)
    assert.exists(b1.in3.proof)
    const proof1 = b1.in3.proof as any
    assert.equal(proof1.type, 'blockProof')
    assert.notExists(proof1.block) // no block needed
    assert.exists(proof1.transactions) // transactions are needed to calc the transactionRoot

    const b = await client.sendRPC('eth_getBlockByNumber', ['latest', true], null, { keepIn3: true })

    const result = b.result as any as BlockData
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'blockProof')
    assert.notExists(proof.block) // no block needed
    assert.notExists(proof.transactions) // no block needed

    const block = new serialize.Block(b.result)

    assert.equal('0x' + block.hash().toString('hex').toLowerCase(), (b.result as any as BlockData).hash, 'the hash of the blockheader in the proof must be the same as the blockHash in the Transactiondata')


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getBlockByNumber' }, (req, re: RPCResponse) => {
        // we change a property
        (re.result as any).gasUsed = (re.result as any).gasLimit
        return re
      })
      await client.sendRPC('eth_getBlockByNumber', [(b.result as any as BlockData).number, true])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated block must fail!')
  })

  it('eth_getBlockByHash', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // send 1000 wei from a to b
    const receipt = await tx.sendTransaction(test.url, {
      privateKey: pk1,
      gas: 22000,
      to: pk1.substr(0, 42), // any address, we just need a simple transaction in the last block
      data: '',
      value: 1000,
      confirm: true
    })

    // get the last Block
    const b = await client.sendRPC('eth_getBlockByHash', [receipt.blockHash, true], null, { keepIn3: true })
    const result = b.result as any as BlockData
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'blockProof')
    assert.notExists(proof.block) // no block needed
    assert.notExists(proof.transactions) // no block needed

    const block = new serialize.Block(b.result)

    assert.equal('0x' + block.hash().toString('hex').toLowerCase(), receipt.blockHash, 'the hash of the blockheader in the proof must be the same as the blockHash in the Transactiondata')


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getBlockByHash' }, (req, re: RPCResponse) => {
        // we change a property
        (re.result as any).gasUsed = (re.result as any).gasLimit
        return re
      })
      await client.sendRPC('eth_getBlockByHash', [receipt.blockHash, true])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated block must fail!')
  })


  it('eth_getBalance', async () => {
    let test = new TestTransport(1) // create a network of 3 nodes
    let client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')
    const adr = getAddress(pk1)

    // get the last Block
    const b = await client.sendRPC('eth_getBalance', [adr, 'latest'], null, { keepIn3: true })
    const result = b.result as any as BlockData
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'accountProof')
    assert.exists(proof.block)
    assert.exists(Object.keys(proof.accounts).length)


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getBalance' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = re.result + '00'
        return re
      })
      await client.sendRPC('eth_getBalance', [adr, 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated balance must fail!')
    test.clearInjectedResponsed()

    // we need to create a new client since the old node is blacklisted
    test = new TestTransport(1) // create a network of 3 nodes
    client = await test.createClient({ proof: true, requestCount: 1 })

    failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getBalance' }, (req, re: RPCResponse) => {
        // we change the returned balance and the value in the proof
        (re.in3.proof as any).account.balance = re.result + '00';
        re.result = re.result + '00'
        return re
      })
      await client.sendRPC('eth_getBalance', [adr, 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated balance must fail!')



  })

  it('eth_getTransactionCount', async () => {
    let test = new TestTransport(1) // create a network of 3 nodes
    let client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')
    const adr = getAddress(pk1)

    // get the last Block
    const b = await client.sendRPC('eth_getTransactionCount', [adr, 'latest'], null, { keepIn3: true })
    const result = b.result as any as BlockData
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'accountProof')
    assert.exists(proof.block)
    assert.exists(Object.keys(proof.accounts).length)


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getTransactionCount' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = re.result + '00'
        return re
      })
      await client.sendRPC('eth_getTransactionCount', [adr, 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')
    test.clearInjectedResponsed()

    // we need to create a new client since the old node is blacklisted
    test = new TestTransport(1) // create a network of 3 nodes
    client = await test.createClient({ proof: true, requestCount: 1 })

    failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getTransactionCount' }, (req, re: RPCResponse) => {
        // we change the returned balance and the value in the proof
        (re.in3.proof as any).account.balance = re.result + '00';
        re.result = re.result + '00'
        return re
      })
      await client.sendRPC('eth_getTransactionCount', [adr, 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')



  })



  it('eth_getCode', async () => {
    let test = new TestTransport(1) // create a network of 3 nodes
    let client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // check empty code
    await client.sendRPC('eth_getCode', [getAddress(pk1), 'latest'], null, { keepIn3: true })

    // check deployed code
    const adr = await deployChainRegistry(pk1)
    const b = await client.sendRPC('eth_getCode', [adr, 'latest'], null, { keepIn3: true })
    const result = b.result as any as BlockData
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'accountProof')
    assert.exists(proof.block)
    assert.exists(Object.keys(proof.accounts).length)


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getCode' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = re.result + '00'
        return re
      })
      await client.sendRPC('eth_getCode', [adr, 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')
    test.clearInjectedResponsed()

    // we need to create a new client since the old node is blacklisted
    test = new TestTransport(1) // create a network of 3 nodes
    client = await test.createClient({ proof: true, requestCount: 1 })

    failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getCode' }, (req, re: RPCResponse) => {
        // we change the returned balance and the value in the proof
        (re.in3.proof as any).account.balance = re.result + '00';
        re.result = re.result + '00'
        return re
      })
      await client.sendRPC('eth_getCode', [adr, 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated code must fail!')

  })



  it('eth_getStorageAt', async () => {
    let test = new TestTransport(1) // create a network of 3 nodes
    let client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount()


    // check deployed code
    const adr = await deployContract('TestContract', pk1)
    await tx.callContract('http://localhost:8545', adr, 'increase()', [], {
      confirm: true,
      privateKey: pk1,
      gas: 3000000,
      value: 0
    })


    const b = await client.sendRPC('eth_getStorageAt', [adr, '0x00', 'latest'], null, { keepIn3: true })
    const result = b.result as string
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'accountProof')
    assert.exists(proof.block)
    assert.exists(Object.keys(proof.accounts).length)
    assert.equal(toHex(result), '0x01')


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getStorageAt' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = '0x09'
        return re
      })
      await client.sendRPC('eth_getStorageAt', [adr, '0x00', 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')

    test = new TestTransport(1) // create a network of 3 nodes
    client = await test.createClient({ proof: true, requestCount: 1 })

    failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getStorageAt' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = '0x09';
        (re.in3.proof as any).account.storageProof[0].value = re.result
        return re
      })
      await client.sendRPC('eth_getStorageAt', [adr, '0x00', 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')


  })


  it('eth_getBlockTransactionCountByNumber', async () => {
    const test = new TestTransport(1) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // send 1000 wei from a to b
    const receipt = await tx.sendTransaction(test.url, {
      privateKey: pk1,
      gas: 22000,
      to: pk1.substr(0, 42), // any address, we just need a simple transaction in the last block
      data: '',
      value: 1000,
      confirm: true
    })

    // get the last Block
    const b1 = await client.sendRPC('eth_getBlockTransactionCountByNumber', ['latest'], null, { keepIn3: true })

    const result1 = b1.result as any as BlockData
    assert.exists(b1.in3)
    assert.exists(b1.in3.proof)
    const proof1 = b1.in3.proof as any
    assert.equal(proof1.type, 'blockProof')
    assert.exists(proof1.block) // no block needed
    assert.exists(proof1.transactions) // transactions are needed to calc the transactionRoot
    assert.equal(b1.result, '0x1')

    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getBlockTransactionCountByNumber' }, (req, re: RPCResponse) => {
        // we change a property
        re.result = '0x04'
        return re
      })
      await client.sendRPC('eth_getBlockTransactionCountByNumber', ['latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated block must fail!')
  })


  it('eth_getBlockTransactionCountByHash', async () => {
    const test = new TestTransport(1) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // send 1000 wei from a to b
    const receipt = await tx.sendTransaction(test.url, {
      privateKey: pk1,
      gas: 22000,
      to: pk1.substr(0, 42), // any address, we just need a simple transaction in the last block
      data: '',
      value: 1000,
      confirm: true
    })

    const hash = await client.sendRPC('eth_getBlockByNumber', ['latest'], null, { keepIn3: true }).then(_ => (_.result as any).hash)

    // get the last Block
    const b1 = await client.sendRPC('eth_getBlockTransactionCountByHash', [hash], null, { keepIn3: true })

    const result1 = b1.result as any as BlockData
    assert.exists(b1.in3)
    assert.exists(b1.in3.proof)
    const proof1 = b1.in3.proof as any
    assert.equal(proof1.type, 'blockProof')
    assert.exists(proof1.block) // no block needed
    assert.exists(proof1.transactions) // transactions are needed to calc the transactionRoot
    assert.equal(b1.result, '0x1')

    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getBlockTransactionCountByHash' }, (req, re: RPCResponse) => {
        // we change a property
        re.result = '0x04'
        return re
      })
      await client.sendRPC('eth_getBlockTransactionCountByHash', [hash])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated block must fail!')
  })







  it('eth_call', async () => {
    let test = new TestTransport(1) // create a network of 3 nodes
    let client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount()


    // check deployed code
    const adr = await deployContract('TestContract', pk1)

    // check deployed code
    const adr2 = await deployContract('TestContract', pk1)

    // increase the count 
    await tx.callContract('http://localhost:8545', adr, 'increase()', [], {
      confirm: true,
      privateKey: pk1,
      gas: 3000000,
      value: 0
    })

    // increase the count 
    await tx.callContract('http://localhost:8545', adr2, 'increase()', [], {
      confirm: true,
      privateKey: pk1,
      gas: 3000000,
      value: 0
    })

    const txArgs = {
      from: getAddress(pk1),
      to: adr,
      data: '0x61bc221a'
    }
    const b1 = await client.sendRPC('eth_call', [{ from: txArgs.from, to: adr2, data: '0x' + simpleEncode('add(address)', adr).toString('hex') }, 'latest'], null, { keepIn3: true, includeCode: true })
    const result1 = b1.result as string
    assert.exists(b1.in3)
    assert.exists(b1.in3.proof)
    const proof1 = b1.in3.proof as any
    assert.equal(proof1.type, 'callProof')
    assert.exists(proof1.block)
    assert.exists(proof1.accounts)
    assert.equal(toHex(result1), '0x0000000000000000000000000000000000000000000000000000000000000002')


    const b = await client.sendRPC('eth_call', [txArgs], null, { keepIn3: true, includeCode: true })

    const result = b.result as string
    assert.exists(b.in3)
    assert.exists(b.in3.proof)
    const proof = b.in3.proof as any
    assert.equal(proof.type, 'callProof')
    assert.exists(proof.block)
    assert.exists(proof.accounts)
    assert.equal(toHex(result), '0x0000000000000000000000000000000000000000000000000000000000000001')


    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_call' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = '0x09'
        return re
      })
      await client.sendRPC('eth_call', [txArgs])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')

    test = new TestTransport(1) // create a network of 3 nodes
    client = await test.createClient({ proof: true, requestCount: 1 })

    failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getStorageAt' }, (req, re: RPCResponse) => {
        // we change the returned balance
        re.result = '0x09';
        (re.in3.proof as any).account.storageProof[0].value = re.result
        return re
      })
      await client.sendRPC('eth_getStorageAt', [adr, '0x00', 'latest'])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated nonce must fail!')


  })




  it('eth_getLogs', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // check deployed code
    const adr = await deployContract('TestContract', pk1)
    const receipt = await tx.callContract('http://localhost:8545', adr, 'increase()', [], {
      confirm: true,
      privateKey: pk1,
      gas: 3000000,
      value: 0
    })

    assert.equal(receipt.logs.length, 1)

    const res = await client.sendRPC('eth_getLogs', [{ fromBlock: toHex(receipt.blockNumber) }], null, { keepIn3: true })
    const result = res.result as any
    assert.exists(res.in3)
    assert.exists(res.in3.proof)
    const proof = res.in3.proof as any as Proof
    assert.equal(proof.type, 'logProof')
    assert.exists(proof.logProof)

    logger.info('result', res)

    let failed = false
    try {
      // now manipulate the result
      test.injectResponse({ method: 'eth_getLogs' }, (req, re: RPCResponse) => {
        // we change a property
        ((re.result as any)[0] as LogData).address = getAddress(pk1)
        return re
      })
      await client.sendRPC('eth_getLogs', [{ fromBlock: toHex(receipt.blockNumber) }])
    }
    catch {
      failed = true
    }
    assert.isTrue(failed, 'The manipulated transaction must fail!')
  })


  it('eth_newBlockFilter', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // current blockNumber
    const blockNumber = await client.sendRPC('eth_blockNumber', []).then(_ => parseInt(_.result as any))

    // create filter
    const filterId = await client.sendRPC('eth_newBlockFilter', []).then(_ => _.result as string)

    // first call should return an empty array
    let changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

    // create an accounts, which creates an block, so the filter should give us now 1 block.
    const pk1 = await test.createAccount('0x01')

    // now we should receive a new BlockHash
    changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 1)

    // but the second call should not return anything since no new blocks were produced
    changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

  })

  it('eth_getFilterChanges', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // current blockNumber
    const blockNumber = await client.sendRPC('eth_blockNumber', []).then(_ => parseInt(_.result as any))

    // create filter
    const filterId = await client.sendRPC('eth_newBlockFilter', []).then(_ => _.result as string)

    // first call should return an empty array
    let changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

    // create an accounts, which creates an block, so the filter should give us now 1 block.
    const pk1 = await test.createAccount('0x01')

    // now we should receive a new BlockHash
    changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 1)

    // current blockNumber
    const block = await client.sendRPC('eth_getBlockByNumber', ['latest']).then(_ => _.result as any as BlockData)
    assert.equal(changes[0], block.hash)

    // but the second call should not return anything since no new blocks were produced
    changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

  })


  it('eth_newFilter', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })
    // create 2 accounts
    const pk1 = await test.createAccount('0x01')

    // check deployed code
    const address = await deployContract('TestContract', pk1)

    // current blockNumber
    const blockNumber = await client.sendRPC('eth_blockNumber', []).then(_ => parseInt(_.result as any))

    // create filter for all events from the deployed contracts
    const filterId = await client.sendRPC('eth_newFilter', [{ address }]).then(_ => _.result as string)

    // first call should return an empty array
    let changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

    // now run a transaction and trigger an event
    const receipt = await tx.callContract('http://localhost:8545', address, 'increase()', [], {
      confirm: true,
      privateKey: pk1,
      gas: 3000000,
      value: 0
    })

    // this filter should now return the event
    changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 1)

    // this filter should now an empty []
    changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

  })


  it('eth_uninstallFilter', async () => {
    const test = new TestTransport(3) // create a network of 3 nodes
    const client = await test.createClient({ proof: true, requestCount: 1 })

    // create filter
    const filterId = await client.sendRPC('eth_newBlockFilter', []).then(_ => _.result as string)

    let changes = await client.sendRPC('eth_getFilterChanges', [filterId]).then(_ => _.result as string[])
    assert.equal(changes.length, 0)

    assert.equal(await client.sendRPC('eth_uninstallFilter', [filterId]).then(_ => _.result as any as boolean), true)
    assert.equal(await client.sendRPC('eth_uninstallFilter', [filterId]).then(_ => _.result as any as boolean), false)

  })


})

