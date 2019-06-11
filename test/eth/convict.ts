
/***********************************************************
* This file is part of the Slock.it IoT Layer.             *
* The Slock.it IoT Layer contains:                         *
*   - USN (Universal Sharing Network)                      *
*   - INCUBED (Trustless INcentivized remote Node Network) *
************************************************************
* Copyright (C) 2016 - 2018 Slock.it GmbH                  *
* All Rights Reserved.                                     *
************************************************************
* You may use, distribute and modify this code under the   *
* terms of the license contract you have concluded with    *
* Slock.it GmbH.                                           *
* For information about liability, maintenance etc. also   *
* refer to the contract concluded with Slock.it GmbH.      *
************************************************************
* For more information, please refer to https://slock.it   *
* For questions, please contact info@slock.it              *
***********************************************************/

import { assert } from 'chai'
import 'mocha'
import { util, BlockData, serialize, Signature, RPCRequest, RPCResponse, transport } from 'in3'
import * as tx from '../../src/util/tx'
import * as ethUtil from 'ethereumjs-util'
import { TestTransport, LoggingAxiosTransport } from '../utils/transport'
import Watcher from '../../src/chains/watch'
import { registerServers } from '../../src/util/registry'
import { toBN, toBuffer } from 'in3/js/src/util/util';
import { BigNumber } from 'ethers/utils';


const address = serialize.address
const bytes32 = serialize.bytes32
const toNumber = util.toNumber
const toHex = util.toHex


const sign = (b: BlockData, pk: string, blockHash?: string) => {
  const msgHash = ethUtil.keccak(Buffer.concat([bytes32(blockHash || b.hash), bytes32(b.number)]))
  const s = ethUtil.ecsign(msgHash, bytes32(pk))
  return {
    ...s,
    block: toNumber(b.number),
    blockHash: blockHash || b.hash,
    address: util.getAddress(pk),
    msgHash: toHex(msgHash, 32),
    r: toHex(s.r),
    s: toHex(s.s),
    v: s.v
  } as Signature
}


const signVote = (blockhash: string, owner: string, pk: string) => {

  const msgHash = (ethUtil.keccak(blockhash + owner.substr(2)))
  const msgHash2 = ethUtil.keccak(toHex("\x19Ethereum Signed Message:\n32") + toHex(msgHash).substr(2))
  const s = ethUtil.ecsign((msgHash2), bytes32(pk))

  return {
    ...s,
    address: util.getAddress(pk),
    msgHash: toHex(msgHash, 32),
    signature: toHex(s.r) + toHex(s.s).substr(2) + toHex(s.v).substr(2),
    r: toHex(s.r),
    s: toHex(s.s),
    v: s.v
  }
}

describe('Convict', () => {

  it('convict on contracts', async () => {

    const test = await TestTransport.createWithRegisteredServers(2)

    const blockHashRegAddress = "0x" + (await tx.callContract(test.url, test.nodeList.contract, 'blockRegistry():(address)', []))[0].toString('hex')

    // creating a snaphsot
    const snapshotreceipt = await tx.callContract(test.url, blockHashRegAddress, 'snapshot()', [], { privateKey: test.getHandlerConfig(1).privateKey, to: blockHashRegAddress, value: 0, confirm: true, gas: 5000000 })

    const blockNumberInSnapshot = toNumber(snapshotreceipt.blockNumber) - 1

    const convictOwner = util.getAddress(test.getHandlerConfig(0).privateKey)

    // make sure we have more than 256 blocks in order to test older blocks
    const currentBlock = parseInt(await test.getFromServer('eth_blockNumber'))
    for (let b = 0; b < 300 - currentBlock; b++) {
      await await test.createAccount(null, '0x27147114878000')
    }

    // read current Block
    let block = await test.getFromServer('eth_getBlockByNumber', 'latest', false) as BlockData
    // create a event-watcher starting with the current block
    const watcher = new Watcher(test.getHandler(0), 0, null, toNumber(block.number))

    // sign the correct blockhash 
    let s = sign(block, test.getHandlerConfig(0).privateKey)

    let convictSignature: Buffer = ethUtil.keccak(Buffer.concat([bytes32(s.blockHash), address(util.getAddress(test.getHandlerConfig(1).privateKey)), toBuffer(s.v, 1), bytes32(s.r), bytes32(s.s)]))

    await tx.callContract(test.url, test.nodeList.contract, 'convict(uint,bytes32)', [s.block, convictSignature], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: false                       //  we are not waiting for confirmation, since we want to deliver the answer to the client.
    })

    let rc = await tx.callContract(test.url, test.nodeList.contract, 'revealConvict(address,bytes32,uint,uint8,bytes32,bytes32)', [convictOwner, s.blockHash, s.block, s.v, s.r, s.s], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false)
    assert.isFalse(rc, 'Transaction must fail, because we sent the correct hash')
    assert.include(await test.getErrorReason(), "the block is too old or you try to convict with a correct hash")
    // now test if we can send a wrong blockhash, but the block is older than 256 blocks:
    // wrong blockhash signed by first node
    s = sign({ number: 1 } as any, test.getHandlerConfig(0).privateKey, '0x0000000000000000000000000000000000000000000000000000000000001234')

    convictSignature = ethUtil.keccak(Buffer.concat([bytes32(s.blockHash), address(util.getAddress(test.getHandlerConfig(1).privateKey)), toBuffer(s.v, 1), bytes32(s.r), bytes32(s.s)]))
    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'convict(uint,bytes32)', [0, convictSignature], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true                       //  we are not waiting for confirmation, since we want to deliver the answer to the client.
    }).catch(_ => false))
    assert.include(await test.getErrorReason(), "block not found")

    rc = await tx.callContract(test.url, test.nodeList.contract, 'revealConvict(address,bytes32,uint,uint8,bytes32,bytes32)', [convictOwner, s.blockHash, s.block, s.v, s.r, s.s], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false)
    assert.isFalse(rc, 'Transaction must fail, because the block is too old')
    assert.include(await test.getErrorReason(), "wrong convict hash")

    const serverContract = await test.getServerFromContract(0)

    block = await test.getFromServer('eth_getBlockByNumber', toHex(blockNumberInSnapshot), false) as BlockData
    s = sign(block, test.getHandlerConfig(0).privateKey)

    convictSignature = ethUtil.keccak(Buffer.concat([bytes32(s.blockHash), address(util.getAddress(test.getHandlerConfig(1).privateKey)), toBuffer(s.v, 1), bytes32(s.r), bytes32(s.s)]))
    await tx.callContract(test.url, test.nodeList.contract, 'convict(uint,bytes32)', [s.block, convictSignature], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true                       //  we are not waiting for confirmation, since we want to deliver the answer to the client.
    })

    rc = await tx.callContract(test.url, test.nodeList.contract, 'revealConvict(address,bytes32,uint,uint8,bytes32,bytes32)', [convictOwner, s.blockHash, s.block, s.v, s.r, s.s], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false)

    assert.isFalse(rc, 'Transaction must fail, because block is correct')
    assert.include(await test.getErrorReason(), "the block is too old or you try to convict with a correct hash")

    // wrong blockhash signed by first node
    s = sign({ number: blockNumberInSnapshot } as any, test.getHandlerConfig(0).privateKey, '0x0000000000000000000000000000000000000000000000000000000000001234')

    // the sender to convit will be second node
    const sender = util.getAddress(test.getHandlerConfig(1).privateKey)

    // get the balance
    const balanceSenderBefore = new BigNumber(await test.getFromServer('eth_getBalance', sender, 'latest'))
    const balanceRegistryBefore = new BigNumber(await test.getFromServer('eth_getBalance', test.nodeList.contract, 'latest'))

    const convictSignatureWrong: Buffer = ethUtil.keccak(Buffer.concat([bytes32(s.blockHash), address(util.getAddress(test.getHandlerConfig(1).privateKey)), toBuffer(s.v, 1), bytes32(s.s), bytes32(s.s)]))

    await tx.callContract(test.url, test.nodeList.contract, 'convict(uint,bytes32)', [s.block, convictSignatureWrong], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true                       //  we are not waiting for confirmation, since we want to deliver the answer to the client.
    })

    rc = await tx.callContract(test.url, test.nodeList.contract, 'revealConvict(address,bytes32,uint,uint8,bytes32,bytes32)', [convictOwner, s.blockHash, s.block, s.v, s.r, s.s], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false)
    assert.include(await test.getErrorReason(), "wrong convict hash")

    assert.isFalse(rc, 'Transaction must fail, convict signature is wrong')


    // send the transactions to convict with the wrong hash
    convictSignature = ethUtil.keccak(Buffer.concat([bytes32(s.blockHash), address(util.getAddress(test.getHandlerConfig(1).privateKey)), toBuffer(s.v, 1), bytes32(s.r), bytes32(s.s)]))

    await tx.callContract(test.url, test.nodeList.contract, 'convict(uint,bytes32)', [s.block, convictSignature], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    })

    await tx.callContract(test.url, test.nodeList.contract, 'revealConvict(address,bytes32,uint,uint8,bytes32,bytes32)', [convictOwner, s.blockHash, s.block, s.v, s.r, s.s], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    })

    const balanceSenderAfter = new BigNumber(await test.getFromServer('eth_getBalance', sender, 'latest'))
    const balanceRegistryAfter = new BigNumber(await test.getFromServer('eth_getBalance', test.nodeList.contract, 'latest'))

    assert.equal((balanceSenderAfter.sub(balanceSenderBefore)).toString(), new BigNumber(serverContract.deposit / 2).toString())

    assert.equal(balanceRegistryBefore.sub(balanceRegistryAfter).toString(), serverContract.deposit)
    const events = await watcher.update()
    assert.equal(events.length, 2)
    assert.equal(events.map(_ => _.event).join(), 'LogServerConvicted,LogServerRemoved')

  }).timeout(500000)

  it('verify and convict (block within 256 blocks)', async () => {

    const test = await TestTransport.createWithRegisteredServers(2)
    const watcher = test.getHandler(0).watcher

    const pk1 = test.getHandlerConfig(0).privateKey

    const block = await test.getFromServer('eth_getBlockByNumber', 'latest', false) as BlockData
    const client = await test.createClient()

    // this is a correct signature and should not fail.
    const res = await client.sendRPC('eth_getBalance', [util.getAddress(pk1), 'latest'], undefined, {
      keepIn3: true, proof: 'standard', signatureCount: 1, requestCount: 1
    })

    assert.isDefined(res.in3.proof.signatures[0])
    test.injectRandom([0.01, 0.9])
    test.injectRandom([0.02, 0.8])

    let manipulated = false
    test.injectResponse({ method: 'in3_sign' }, (req: RPCRequest, re: RPCResponse, url: string) => {
      const index = parseInt(url.substr(1)) - 1
      // we change it to a wrong signature
      if (!manipulated) {
        re.result = [sign(block, test.getHandlerConfig(index).privateKey, pk1)]
        manipulated = true
      }
      return re
    })

    assert.equal(await test.getServerCountFromContract(), 2)

    // we create a new client because the old one may have different weights now
    const client2 = await test.createClient()

    // just read all events
    await watcher.update()

    // this is a correct signature and should not fail.
    await client2.sendRPC('eth_getBalance', [util.getAddress(pk1), 'latest'], undefined, {
      keepIn3: true, proof: 'standard', signatureCount: 1, requestCount: 1
    })

    // we should get a valid response even though server #0 signed a wrong hash and was convicted server #1 gave a correct one.
    assert.equal(await test.getServerCountFromContract(), 1)

    // just read all events
    const events = await watcher.update()
    assert.equal(events.length, 2)
    assert.equal(events.map(_ => _.event).join(), 'LogServerConvicted,LogServerRemoved')

  })

  it('getValidVoters', async () => {
    const test = await TestTransport.createWithRegisteredServers(1)

    const accounts = []
    for (let i = 0; i < 60; i++) {

      const user = await test.createAccount(null, toBN('500000000000000000'))

      accounts.push({
        privateKey: user,
        address: util.getAddress(user)

      })

      await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['abc' + i, 1000, 10000], { privateKey: user, value: toBN('490000000000000000'), confirm: true, gas: 5000000 })


      const block = await test.getFromServer('eth_getBlockByNumber', 'latest', false) as BlockData
      const blockNumber = toNumber(block.number) - 1

      const [validVoters, votingTime] = (await tx.callContract(test.url, test.nodeList.contract, 'getValidVoters(uint,address):(address[],uint)', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey)]))

      const correctNumber = i < 24 ? i + 1 : 24

      assert.equal(validVoters.length, correctNumber)

    }
  }).timeout(50000)


  it('voteUnregisterServer - votingPower', async () => {
    const test = await TestTransport.createWithRegisteredServers(1)

    await test.increaseTime(86400 * 365 * 2)
    const accounts = []
    for (let i = 0; i < 24; i++) {

      const user = await test.createAccount(null, toBN('4320000000000000000000000'))

      accounts.push({
        privateKey: user,
        address: util.getAddress(user)

      })

      await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['abc' + i, 1000, 10000], { privateKey: user, value: toBN('4320000000000000000000000'), confirm: true, gas: 5000000 })
    }

    let block = await test.getFromServer('eth_getBlockByNumber', 'latest', false) as BlockData

    let blockNumber = toNumber(block.number) - 1

    const validVoters = (await tx.callContract(test.url, test.nodeList.contract, 'getValidVoters(uint,address):(address[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey)]))[0]

    assert.equal(validVoters.length, 24)
    assert.equal(await test.getServerCountFromContract(), 25)

    let blockSign = await test.getFromServer('eth_getBlockByNumber', toHex(blockNumber), false) as BlockData
    const [usedBefore, indexBefore, lockedTimeBefore, depositAmountBefore] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(test.getHandlerConfig(0).privateKey)])

    assert.isTrue(usedBefore)
    assert.equal(indexBefore.toString(), '0')
    assert.equal(lockedTimeBefore.toString(), '0')
    assert.equal(depositAmountBefore.toString(), '0')

    const addressValidVoters = []

    for (const a of validVoters) {
      addressValidVoters.push("0x" + a.toLowerCase())
    }

    const txSig = []
    for (const a of accounts) {

      if (addressValidVoters.includes(a.address.toLowerCase())) {
        const s = signVote(blockSign.hash, util.getAddress(test.getHandlerConfig(0).privateKey), a.privateKey)
        txSig.push(s.signature)
      }
    }

    const nonexistingUser = await test.createAccount(null)

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [1, util.getAddress(test.getHandlerConfig(0).privateKey), []], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 300000 }).catch(_ => false), 'Must fail, because no signatures provided')
    assert.include(await test.getErrorReason(), "block not found")

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(nonexistingUser), []], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 300000 }).catch(_ => false), 'Must fail, because no signatures provided')
    assert.include(await test.getErrorReason(), "owner does not have a server")

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey), []], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 300000 }).catch(_ => false), 'Must fail, because no signatures provided')
    assert.include(await test.getErrorReason(), "provided no signatures")

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey), txSig], { privateKey: accounts[0].privateKey, value: 0, confirm: true, gas: 5000000 }).catch(_ => false), 'Must fail, because not enough voting power')
    assert.include(await test.getErrorReason(), "not enough voting power")

    await test.increaseTime(86400 * 31)

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey), txSig.slice(1, txSig.length)], { privateKey: accounts[0].privateKey, value: 0, confirm: true, gas: 5000000 }).catch(_ => false), 'Must fail, because not enough voting power')
    assert.include(await test.getErrorReason(), "not enough voting power")

    let balanceVoterBefore = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[0].privateKey), 'latest'))

    const voteTx = await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey), txSig], { privateKey: accounts[0].privateKey, value: 0, confirm: true, gas: 6000000 }).catch(_ => false)

    let balanceVoterAfter = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[0].privateKey), 'latest'))

    //test for min (10 finney)
    assert.equal(balanceVoterAfter.sub(balanceVoterBefore).toString(), '0')

    assert.equal(await test.getServerCountFromContract(), 24)

    const [usedAfter, indexAfter, lockedTimeAfter, depositAmountAfter] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(test.getHandlerConfig(0).privateKey)])

    assert.isFalse(usedAfter)
    assert.equal(indexAfter.toString(), '0')
    const blockVote = await test.getFromServer('eth_getBlockByNumber', voteTx.blockNumber, false) as BlockData

    assert.equal(lockedTimeAfter.toString(), util.toBN(blockVote.timestamp).add(util.toBN(3600)).toString())
    assert.equal(depositAmountAfter.toString(), '9900000000000000')

    block = await test.getFromServer('eth_getBlockByNumber', 'latest', false) as BlockData
    blockNumber = toNumber(block.number) - 1

    blockSign = await test.getFromServer('eth_getBlockByNumber', toHex(blockNumber), false) as BlockData

    const txSigNew = []
    for (const a of accounts) {

      const s = signVote(blockSign.hash, util.getAddress(accounts[0].privateKey), a.privateKey)
      txSigNew.push(s.signature)

    }
    balanceVoterBefore = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[1].privateKey), 'latest'))

    const voteTx2 = await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(accounts[0].privateKey), txSigNew], { privateKey: accounts[1].privateKey, value: 0, confirm: true, gas: 5000000 })

    const [usedAfter2, indexAfter2, lockedTimeAfter2, depositAmountAfter2] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(accounts[0].privateKey)])
    assert.equal(depositAmountAfter2.toString(), '4276800000000000000000000')

    balanceVoterAfter = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[1].privateKey), 'latest'))

    assert.equal(balanceVoterAfter.sub(balanceVoterBefore).toString(), '0')

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'returnDeposit()', [], { privateKey: accounts[1].privateKey, value: 0, confirm: true, gas: 5000000 }).catch(_ => false), 'Must fail, because deposit is still locked')
    assert.include(await test.getErrorReason(), "nothing to transfer")

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'returnDeposit()', [], { privateKey: accounts[0].privateKey, value: 0, confirm: true, gas: 5000000 }).catch(_ => false), 'Must fail, because deposit is still locked')
    assert.include(await test.getErrorReason(), "deposit still locked")

    await test.increaseTime(10000)

    await test.createAccount(accounts[0].privateKey, toBN('4320000000000000000000000'))

    await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['abc0', 1000, 3600], { privateKey: accounts[0].privateKey, value: toBN('3320000000000000000000000'), confirm: true, gas: 5000000 })
    balanceVoterBefore = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[0].privateKey), 'latest'))

    await tx.callContract(test.url, test.nodeList.contract, 'returnDeposit()', [], {
      privateKey: accounts[0].privateKey, value: 0, confirm: true, gas: 5000000
    })
    balanceVoterAfter = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[0].privateKey), 'latest'))
    assert.equal(balanceVoterAfter.sub(balanceVoterBefore).toString(), '4276800000000000000000000')
    assert.equal(balanceVoterAfter.sub(balanceVoterBefore).toString(), depositAmountAfter2)
    const [usedAfter3, indexAfter3, lockedTimeAfter3, depositAmountAfter3] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(accounts[0].privateKey)])

    assert.isTrue(usedAfter3)
    assert.equal(indexAfter3.toString(), '23')
    assert.equal(lockedTimeAfter3.toString(), 0)
    assert.equal(depositAmountAfter3.toString(), 0)



  }).timeout(50000)

  it('verify and convict (block older then 256 blocks) - worth it', async () => {

    const test = await TestTransport.createWithRegisteredServers(2)
    await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', [test.getHandlerConfig(0).rpcUrl, 0, 0], { privateKey: test.getHandlerConfig(0).privateKey, value: toBN('490000000000000000'), confirm: true, gas: 5000000 })

    const blockHashRegistry = "0x" + (await tx.callContract(test.url, test.nodeList.contract, 'blockRegistry():(address)', []))[0].toString("hex")

    const txReceipt = (await tx.callContract(test.url, blockHashRegistry, 'snapshot()', [], { privateKey: test.getHandlerConfig(1).privateKey, value: 0, confirm: true, gas: 5000000 }))

    const wrongBlock = txReceipt.blockNumber - 0x12C
    const watcher = test.getHandler(0).watcher

    const pk1 = test.getHandlerConfig(0).privateKey
    const pk2 = test.getHandlerConfig(1).privateKey

    const block = await test.getFromServer('eth_getBlockByNumber', toHex(wrongBlock), false) as BlockData

    assert.equal((toNumber(txReceipt.blockNumber) - toNumber(block.number)), 300)

    const client = await test.createClient()

    // this is a correct signature and should not fail.
    const res = await client.sendRPC('eth_getBalance', [util.getAddress(pk1), toHex(wrongBlock)], undefined, {
      keepIn3: true, proof: 'standard', signatureCount: 1, requestCount: 1
    })

    assert.isDefined(res.in3.proof.signatures[0])
    test.injectRandom([0.01, 0.9])
    test.injectRandom([0.02, 0.8])

    let manipulated = false
    test.injectResponse({ method: 'in3_sign' }, (req: RPCRequest, re: RPCResponse, url: string) => {
      const index = parseInt(url.substr(1)) - 1
      // we change it to a wrong signature
      if (!manipulated) {
        re.result = [sign(block, test.getHandlerConfig(index).privateKey, pk1)]
        manipulated = true
      }
      return re
    })


    assert.equal(await test.getServerCountFromContract(), 2)

    // we create a new client because the old one may have different weights now
    const client2 = await test.createClient()

    // just read all events
    await watcher.update()


    // this is a correct signature and should not fail.
    const res2 = await client2.sendRPC('eth_getBalance', [util.getAddress(pk1), toHex(wrongBlock)], undefined, {
      keepIn3: true, proof: 'standard', signatureCount: 1, requestCount: 1
    })

    // we should get a valid response even though server #0 signed a wrong hash and was convicted server #1 gave a correct one.
    assert.equal(await test.getServerCountFromContract(), 1)

    // just read all events
    const events = await watcher.update()
    assert.equal(events.length, 2)

    assert.equal(events.map(_ => _.event).join(), 'LogServerConvicted,LogServerRemoved')

  })

  it('verify and convict - vote kick', async () => {
    const test = await TestTransport.createWithRegisteredServers(1)
    const accounts = []
    for (let i = 0; i < 24; i++) {

      const user = await test.createAccount(null, toBN('590000000000000000'))

      accounts.push({
        privateKey: user,
        address: util.getAddress(user)

      })

      await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['abc' + i, 1000, 10000], { privateKey: user, value: toBN('500000000000000000'), confirm: true, gas: 5000000 })
    }

    const block = await test.getFromServer('eth_getBlockByNumber', 'latest', false) as BlockData

    const blockNumber = toNumber(block.number) - 1

    const validVoters = (await tx.callContract(test.url, test.nodeList.contract, 'getValidVoters(uint,address):(address[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey)]))[0]

    const blockSign = await test.getFromServer('eth_getBlockByNumber', toHex(blockNumber), false) as BlockData
    const [usedBefore, indexBefore, lockedTimeBefore, depositAmountBefore] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(test.getHandlerConfig(0).privateKey)])

    assert.isTrue(usedBefore)
    assert.equal(indexBefore.toString(), '0')
    assert.equal(lockedTimeBefore.toString(), '0')
    assert.equal(depositAmountBefore.toString(), '0')

    const addressValidVoters = []

    for (const a of validVoters) {
      addressValidVoters.push("0x" + a.toLowerCase())
    }

    const txSig = []
    for (const a of accounts) {

      if (addressValidVoters.includes(a.address.toLowerCase())) {
        const s = signVote(blockSign.hash, util.getAddress(test.getHandlerConfig(0).privateKey), a.privateKey)
        txSig.push(s.signature)
      }
    }

    let s = sign({ number: blockNumber } as any, test.getHandlerConfig(0).privateKey, '0x0000000000000000000000000000000000000000000000000000000000001234')
    const convictSignature = ethUtil.keccak(Buffer.concat([bytes32(s.blockHash), address(util.getAddress(accounts[0].privateKey)), toBuffer(s.v, 1), bytes32(s.r), bytes32(s.s)]))
    await tx.callContract(test.url, test.nodeList.contract, 'voteUnregisterServer(uint,address,bytes[])', [blockNumber, util.getAddress(test.getHandlerConfig(0).privateKey), txSig], { privateKey: accounts[0].privateKey, value: 0, confirm: true, gas: 6500000 })
    //    const [usedBeforeConvict, indexBeforeConvict, lockedTimeBeforeConvict, depositBeforeConvict] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(test.getHandlerConfig(0).privateKey)])

    const balanceBeforeConvict = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[0].privateKey), 'latest'))

    await tx.callContract(test.url, test.nodeList.contract, 'convict(uint,bytes32)', [s.block, convictSignature], {
      privateKey: accounts[0].privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    })

    await tx.callContract(test.url, test.nodeList.contract, 'revealConvict(address,bytes32,uint,uint8,bytes32,bytes32)', [util.getAddress(test.getHandlerConfig(0).privateKey), s.blockHash, s.block, s.v, s.r, s.s], {
      privateKey: accounts[0].privateKey,
      gas: 660000,
      value: 0,
      confirm: true
    })
    const balanceAfterConvict = new BigNumber(await test.getFromServer('eth_getBalance', util.getAddress(accounts[0].privateKey), 'latest'))

    // 50% of the 0.0099 ether deposit
    assert.equal(balanceAfterConvict.sub(balanceBeforeConvict).toString(), '4950000000000000')

    const [usedAfterConvict, indexAfterConvict, lockedTimeAfterConvict, depositAfterConvict] = await tx.callContract(test.url, test.nodeList.contract, 'ownerIndex(address):(bool,uint128,uint256,uint256)', [util.getAddress(test.getHandlerConfig(0).privateKey)])

    //assert.equal(depositBeforeConvict.toString(), 10000)
    assert.isFalse(usedAfterConvict)
    assert.equal(depositAfterConvict.toString(), 0)

    assert.equal(lockedTimeAfterConvict.toString(), 0)
    // assert.equal(balanceAfterConvict.sub(balanceBeforeConvict).toString(), '5000')
  })

  it('verify and convict (block older then 256 blocks) - not worth it', async () => {

    const test = await TestTransport.createWithRegisteredServers(2)


    const blockHashRegistry = "0x" + (await tx.callContract(test.url, test.nodeList.contract, 'blockRegistry():(address)', []))[0].toString("hex")

    const txReceipt = (await tx.callContract(test.url, blockHashRegistry, 'snapshot()', [], { privateKey: test.getHandlerConfig(1).privateKey, value: 0, confirm: true, gas: 5000000 }))

    const wrongBlock = txReceipt.blockNumber - 0x12C
    const watcher = test.getHandler(0).watcher

    const pk1 = test.getHandlerConfig(0).privateKey
    const pk2 = test.getHandlerConfig(1).privateKey

    const block = await test.getFromServer('eth_getBlockByNumber', toHex(wrongBlock), false) as BlockData

    assert.equal((toNumber(txReceipt.blockNumber) - toNumber(block.number)), 300)

    const client = await test.createClient()

    // this is a correct signature and should not fail.
    const res = await client.sendRPC('eth_getBalance', [util.getAddress(pk1), toHex(wrongBlock)], undefined, {
      keepIn3: true, proof: 'standard', signatureCount: 1, requestCount: 1
    })

    assert.isDefined(res.in3.proof.signatures[0])
    test.injectRandom([0.01, 0.9])
    test.injectRandom([0.02, 0.8])

    let manipulated = false
    test.injectResponse({ method: 'in3_sign' }, (req: RPCRequest, re: RPCResponse, url: string) => {
      const index = parseInt(url.substr(1)) - 1
      // we change it to a wrong signature
      if (!manipulated) {
        re.result = [sign(block, test.getHandlerConfig(index).privateKey, pk1)]
        manipulated = true
      }
      return re
    })


    assert.equal(await test.getServerCountFromContract(), 2)

    // we create a new client because the old one may have different weights now
    const client2 = await test.createClient()

    // just read all events
    await watcher.update()


    // this is a correct signature and should not fail.
    const res2 = await client2.sendRPC('eth_getBalance', [util.getAddress(pk1), toHex(wrongBlock)], undefined, {
      keepIn3: true, proof: 'standard', signatureCount: 1, requestCount: 1
    })

    // we should get a valid response even though server #0 signed a wrong hash and was convicted server #1 gave a correct one.
    assert.equal(await test.getServerCountFromContract(), 2)

    // just read all events
    const events = await watcher.update()
  })

  it('requestUnregisteringServer - cancel', async () => {

    const test = await TestTransport.createWithRegisteredServers(2)

    const serverBefore = await test.getServerFromContract(0)

    assert.equal(serverBefore.timeout.toNumber(), 3600)
    assert.equal(serverBefore.unregisterTime.toNumber(), 0)

    const receipt = await tx.callContract(test.url, test.nodeList.contract, 'requestUnregisteringServer()', [], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 3000000 })


    let block = await test.getFromServer('eth_getBlockByNumber', receipt.blockNumber, false) as BlockData

    const serverAfter = await test.getServerFromContract(0)

    assert.equal(serverAfter.timeout.toNumber(), 3600)
    assert.equal(serverAfter.unregisterTime - Number(block.timestamp), 3600)

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'requestUnregisteringServer()', [], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 3000000 }).catch(_ => false), 'Must fail, because not the owner of the server')
    assert.include(await test.getErrorReason(), "Server is already unregistering")

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'cancelUnregisteringServer()', [], { privateKey: test.getHandlerConfig(1).privateKey, value: 0, confirm: true, gas: 300000 }).catch(_ => false), 'Must fail, because not the owner of the server')
    assert.include(await test.getErrorReason(), "server is not unregistering")
    await tx.callContract(test.url, test.nodeList.contract, 'cancelUnregisteringServer()', [], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 3000000 })

    const serverAfterCancel = await test.getServerFromContract(0)

    assert.equal(serverAfterCancel.timeout.toNumber(), 3600)
    assert.equal(serverAfterCancel.unregisterTime.toNumber(), 0)

  })

  it('requestUnregisteringServer', async () => {

    const test = await TestTransport.createWithRegisteredServers(2)

    const serverBefore = await test.getServerFromContract(0)

    assert.equal(serverBefore.timeout.toNumber(), 3600)
    assert.equal(serverBefore.unregisterTime.toNumber(), 0)

    const receipt = await tx.callContract(test.url, test.nodeList.contract, 'requestUnregisteringServer()', [], { privateKey: test.getHandlerConfig(0).privateKey, value: 0, confirm: true, gas: 3000000 })


    let block = await test.getFromServer('eth_getBlockByNumber', receipt.blockNumber, false) as BlockData

    const serverAfter = await test.getServerFromContract(0)

    assert.equal(serverAfter.timeout.toNumber(), 3600)
    assert.equal(serverAfter.unregisterTime - Number(block.timestamp), 3600)

    const balanceOwnerBefore = new BigNumber(await test.getFromServer('eth_getBalance', test.nodeList.nodes[0].address, 'latest'))

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'confirmUnregisteringServer()', [], {
      privateKey: test.getHandlerConfig(0).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false), 'Must fail because the owner is not allowed to confirm yet')
    assert.include(await test.getErrorReason(), "Only confirm after the timeout allowed")

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'confirmUnregisteringServer()', [], {
      privateKey: test.getHandlerConfig(1).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false), 'Must fail because the owner did not call requestUnregister before')
    assert.include(await test.getErrorReason(), "Cannot unregister an active server")

    // wait 2h 
    await test.increaseTime(7201)

    await tx.callContract(test.url, test.nodeList.contract, 'confirmUnregisteringServer()', [], {
      privateKey: test.getHandlerConfig(0).privateKey,
      gas: 300000,
      value: 0,
      confirm: true
    })

    const balanceOwnerAfter = new BigNumber(await test.getFromServer('eth_getBalance', test.nodeList.nodes[0].address, 'latest'))

    assert.equal(balanceOwnerAfter.sub(balanceOwnerBefore).toString(), serverBefore.deposit.toString())


  })


  it('registerDuplicate', async () => {
    // create an empty registry
    const test = await new TestTransport(1)
    const pk1 = await test.createAccount(null, toBN('49000000000000000000'))
    const pk2 = await test.createAccount(null, toBN('49000000000000000000'))
    const transport = new LoggingAxiosTransport()

    // register 2 different servers should work
    let registers = await registerServers(pk1, null, [{
      url: 'test1.com',
      deposit: toBN('4900000000000000000'),
      pk: pk1,
      props: '0xff',
      timeout: 7200,
    }, {
      url: 'test2.com',
      deposit: toBN('4900000000000000000'),
      pk: pk2,
      props: '0xff',
      timeout: 7200,
    }], test.chainId, null, test.url, transport, false)

    // register same url servers should not work
    await test.mustFail(
      registerServers(pk1, null, [{
        url: 'test1.com',
        deposit: toBN('4900000000000000000'),
        pk: pk1,
        props: '0xff',
        timeout: 7200,
      }, {
        url: 'test1.com',
        deposit: toBN('4900000000000000000'),
        pk: pk2,
        props: '0xff',
        timeout: 7200,
      }], test.chainId, null, test.url, transport, false)
    )

    assert.include(await test.getErrorReason(), "Server with the same url or owner is already registered")


    // register same pk servers should not work
    await test.mustFail(
      registerServers(pk1, null, [{
        url: 'test1.com',
        deposit: toBN('4900000000000000000'),
        pk: pk1,
        props: '0xff',
        timeout: 3600
      }, {
        url: 'test2.com',
        deposit: toBN('4900000000000000000'),
        pk: pk1,
        props: '0xff',
        timeout: 3600
      }], test.chainId, null, test.url, transport, false)
    )
    assert.include(await test.getErrorReason(), "Server with the same url or owner is already registered")

  })

  it('updateServer', async () => {


    const test = await TestTransport.createWithRegisteredServers(2)
    let serverBefore = await test.getServerFromContract(0)
    assert.equal(serverBefore.timeout.toNumber(), 3600)
    assert.equal(toHex(serverBefore.props), "0xffff")

    const pk1 = await test.createAccount(null, toBN('4900000000000000000'))
    const transport = new LoggingAxiosTransport()

    assert.equal(await test.getServerCountFromContract(), 2)

    await registerServers(pk1, test.nodeList.contract, [{
      url: 'test3.com',
      deposit: toBN('4900000000000000000'),
      pk: pk1,
      props: '0xff',
      timeout: 7200,
    }], test.chainId, null, test.url, transport, false)

    assert.equal(await test.getServerCountFromContract(), 3)

    serverBefore = await test.getServerFromContract(2)
    assert.equal(toNumber(serverBefore.timeout), 7200)
    assert.equal(toHex(serverBefore.props), "0xff")

    // changing props
    await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ["test3.com", 0x0fff, 0], { privateKey: pk1, value: 0, confirm: true, gas: 3000000 })
    let serverAfter = await test.getServerFromContract(2)

    assert.equal(toNumber(serverAfter.timeout), 7200)
    assert.equal(toHex(serverAfter.props), "0x0fff")

    await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ["test3.com", 0x0fff, 14400], { privateKey: pk1, value: 0, confirm: true, gas: 3000000 })
    serverAfter = await test.getServerFromContract(2)
    assert.equal(toHex(serverAfter.props), "0x0fff")
    assert.equal(toNumber(serverAfter.timeout), 14400)

    await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ["test3.com", 0xffff, 16400], { privateKey: pk1, value: 0, confirm: true, gas: 3000000 })
    serverAfter = await test.getServerFromContract(2)
    assert.equal(toHex(serverAfter.props), "0xffff")
    assert.equal(toNumber(serverAfter.timeout), 16400)

    const randomAccount = await test.createAccount(null, '0x27147114878000')

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ["test3.com", 0xffff, 16400], {
      privateKey: randomAccount,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false), 'Must fail because the owner does not have a server yet')
    assert.include(await test.getErrorReason(), "sender does not own a server")

    const richUser = await test.createAccount(null, toBN("100000000000000000000"))

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['abc', 1000, 10000], { privateKey: richUser, value: toBN('50000000000000000000'), confirm: true, gas: 5000000 }).catch(_ => false), 'Must fail because the owner does not have a server yet')
    assert.include(await test.getErrorReason(), "Limit of 50 ETH reached")

    await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['abc', 1000, 10000], { privateKey: richUser, value: toBN('5000000000000000000'), confirm: true, gas: 5000000 })

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ['abc', 0xffff, 16400], { privateKey: richUser, value: toBN('50000000000000000000'), confirm: true, gas: 5000000 }).catch(_ => false), 'Must fail because the owner does not have a server yet')
    assert.include(await test.getErrorReason(), "Limit of 50 ETH reached")

    await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ['abc', 0xffff, 16400], { privateKey: richUser, value: toBN('5000000000000000000'), confirm: true, gas: 5000000 })

    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'updateServer(string,uint,uint64)', ["test3.com", 0xffff, 16400], {
      privateKey: richUser,
      gas: 300000,
      value: 0,
      confirm: true
    }).catch(_ => false), 'Must fail because the url is already taken')
    assert.include(await test.getErrorReason(), "url is already in use")

  })

  it('calculate min deposit', async () => {
    const test = await TestTransport.createWithRegisteredServers(2)
    let minDeposit = await tx.callContract(test.url, test.nodeList.contract, 'calculateMinDeposit(uint):(uint)', [0])

    // in the 1st 2 weeks we use 10 finney
    assert.equal(minDeposit.toString(), "10000000000000000")

    await test.increaseTime(86400 * 366)

    // should not have changed
    minDeposit = await tx.callContract(test.url, test.nodeList.contract, 'calculateMinDeposit(uint):(uint)', [0])
    assert.equal(minDeposit.toString(), "10000000000000000")

    const pk1 = await test.createAccount(null, toBN('51000000000000000000'))
    const pk2 = await test.createAccount(null, toBN('86400000000000000000000'))

    await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['server1', 1000, 10000], { privateKey: pk1, value: toBN('10000000000000000'), confirm: true, gas: 5000000 })
    assert.isFalse(await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['server1', 1000, 10000], { privateKey: pk1, value: toBN('10000000000000000'), confirm: true, gas: 5000000 }).catch(_ => false))
    assert.include(await test.getErrorReason(), "not enough deposit")
    assert.equal((await tx.callContract(test.url, test.nodeList.contract, 'calculateMinDeposit(uint):(uint)', [0])).toString(), '864000000000000000000')

    await tx.callContract(test.url, test.nodeList.contract, 'registerServer(string,uint,uint64)', ['server2', 1000, 10000], { privateKey: pk2, value: toBN('86400000000000000000000'), confirm: true, gas: 6000000 })
    assert.equal((await tx.callContract(test.url, test.nodeList.contract, 'calculateMinDeposit(uint):(uint)', [0])).toString(), '4320000000000000000000000')



  })



})
