import test from 'ava'
import { CID } from 'multiformats'

import Branch from '../src/user-store/branch.js'
import IpldStore from '../src/blockstore/ipld-store.js'
import Timestamp from '../src/timestamp.js'
import * as util from './_util.js'


type Context = {
  store: IpldStore
  branch: Branch
  cid: CID
  cid2: CID
}

test.beforeEach(async t => {
  const store = IpldStore.createInMemory()
  const branch = await Branch.create(store)
  const cid = await util.randomCid()
  const cid2 = await util.randomCid()
  t.context = { store, branch, cid, cid2 } as Context
  t.pass('Context setup')
})

test('basic operations', async t => {
  const { branch, cid, cid2 } = t.context as Context
  const id = Timestamp.now()

  await branch.addEntry(id, cid)
  t.pass('adds data')
  let got = await branch.getEntry(id)
  t.is(got?.toString(), cid.toString(), 'retrieves correct data')

  await branch.editEntry(id, cid2)
  got = await branch.getEntry(id)
  t.is(got?.toString(), cid2.toString(), 'edits data')

  await branch.deleteEntry(id)
  t.is(await branch.getEntry(id), null, 'deletes data')
})

test("splitting tables", async t => {
  const { branch, store, cid } = t.context as Context
  const ids = util.generateBulkIds(100)
  for (const id of ids) {
    await branch.addEntry(id, cid)
  }
  t.is(branch.tableCount(), 1, "Does not split at 100 entries")

  await branch.addEntry(Timestamp.now(), cid)
  t.is(branch.tableCount(), 2, "Does split at 101 entries")
})

test("compressing tables", async t => {
  const { branch, cid } = t.context as Context

  const ids = util.generateBulkIds(6401)
  const firstBatch = ids.slice(0,400)
  const threshold = ids[400]
  const secondBatch = ids.slice(401, 6400)
  const final = ids[6400]
  for (const id of firstBatch) {
    await branch.addEntry(id, cid)
  }
  t.is(branch.tableCount(), 4, "Does not compress at 4 tables")

  await branch.addEntry(threshold, cid)
  t.is(branch.tableCount(), 2, "Compresses oldest 4 tables once there are 5 tables")

  for (const id of secondBatch) {
    await branch.addEntry(id, cid)
  }
  t.is(branch.tableCount(), 10, 'Does not compress at any level until necessary')

  await branch.addEntry(final, cid)
  t.is(branch.tableCount(), 2, "Cascades compression of all tables to an xl table")
})
