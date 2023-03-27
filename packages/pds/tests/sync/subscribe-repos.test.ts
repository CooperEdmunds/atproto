import AtpAgent from '@atproto/api'
import {
  cidForCbor,
  HOUR,
  MINUTE,
  readFromGenerator,
  wait,
} from '@atproto/common'
import { randomStr } from '@atproto/crypto'
import * as repo from '@atproto/repo'
import { getWriteLog, MemoryBlockstore, WriteOpAction } from '@atproto/repo'
import { byFrame, ErrorFrame, Frame, MessageFrame } from '@atproto/xrpc-server'
import { WebSocket } from 'ws'
import { Commit as CommitEvt } from '../../src/lexicon/types/com/atproto/sync/subscribeRepos'
import { AppContext, Database } from '../../src'
import { SeedClient } from '../seeds/client'
import basicSeed from '../seeds/basic'
import { CloseFn, runTestServer } from '../_util'
import { sql } from 'kysely'

describe('repo subscribe repos', () => {
  let serverHost: string

  let db: Database
  let ctx: AppContext

  let agent: AtpAgent
  let sc: SeedClient
  let alice: string
  let bob: string
  let carol: string
  let dan: string

  let close: CloseFn

  beforeAll(async () => {
    const server = await runTestServer({
      dbPostgresSchema: 'repo_subscribe_repos',
    })
    serverHost = server.url.replace('http://', '')
    ctx = server.ctx
    db = server.ctx.db
    close = server.close
    agent = new AtpAgent({ service: server.url })
    sc = new SeedClient(agent)
    await basicSeed(sc)
    alice = sc.dids.alice
    bob = sc.dids.bob
    carol = sc.dids.carol
    dan = sc.dids.dan
  })

  afterAll(async () => {
    await close()
  })

  const getRepo = async (did: string) => {
    const car = await agent.api.com.atproto.sync.getRepo({ did })
    const storage = new MemoryBlockstore()
    const synced = await repo.loadFullRepo(
      storage,
      new Uint8Array(car.data),
      did,
      ctx.repoSigningKey.did(),
    )
    return repo.Repo.load(storage, synced.root)
  }

  const verifyEvents = async (evts: Frame[]) => {
    const byUser = evts.reduce((acc, cur) => {
      const evt = cur.body as CommitEvt
      acc[evt.repo] ??= []
      acc[evt.repo].push(evt)
      return acc
    }, {} as Record<string, CommitEvt[]>)

    await verifyRepo(alice, byUser[alice])
    await verifyRepo(bob, byUser[bob])
    await verifyRepo(carol, byUser[carol])
    await verifyRepo(dan, byUser[dan])
  }

  const verifyRepo = async (did: string, evts: CommitEvt[]) => {
    const didRepo = await getRepo(did)
    const writeLog = await getWriteLog(didRepo.storage, didRepo.cid, null)
    const commits = await didRepo.storage.getCommits(didRepo.cid, null)
    if (!commits) {
      return expect(commits !== null)
    }
    expect(evts.length).toBe(commits.length)
    expect(evts.length).toBe(writeLog.length)
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i]
      const evt = evts[i]
      expect(evt.repo).toEqual(did)
      expect(evt.commit.toString()).toEqual(commit.commit.toString())
      expect(evt.prev?.toString()).toEqual(commits[i - 1]?.commit?.toString())
      const car = await repo.readCarWithRoot(evt.blocks as Uint8Array)
      expect(car.root.equals(commit.commit))
      expect(car.blocks.equals(commit.blocks))
      const writes = writeLog[i].map((w) => ({
        action: w.action,
        path: w.collection + '/' + w.rkey,
        cid: w.action === WriteOpAction.Delete ? null : w.cid.toString(),
      }))
      const sortedOps = evt.ops
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((op) => ({ ...op, cid: op.cid?.toString() ?? null }))
      const sortedWrites = writes.sort((a, b) => a.path.localeCompare(b.path))
      expect(sortedOps).toEqual(sortedWrites)
    }
  }

  const randomPost = async (by: string) => sc.post(by, randomStr(8, 'base32'))
  const makePosts = async () => {
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(randomPost(alice))
      promises.push(randomPost(bob))
      promises.push(randomPost(carol))
      promises.push(randomPost(dan))
    }
    await Promise.all(promises)
  }

  const readTillCaughtUp = async <T>(
    gen: AsyncGenerator<T>,
    waitFor?: Promise<unknown>,
  ) => {
    const isDone = async (evt: any) => {
      if (evt === undefined) return false
      if (evt instanceof ErrorFrame) return true
      const curr = await db.db
        .selectFrom('repo_seq')
        .select('seq')
        .limit(1)
        .orderBy('seq', 'desc')
        .executeTakeFirst()
      return curr !== undefined && evt.body.seq === curr.seq
    }

    return readFromGenerator(gen, isDone, waitFor)
  }

  it('sync backfilled events', async () => {
    const ws = new WebSocket(
      `ws://${serverHost}/xrpc/com.atproto.sync.subscribeRepos?cursor=${-1}`,
    )

    const gen = byFrame(ws)
    const evts = await readTillCaughtUp(gen)
    ws.terminate()

    await verifyEvents(evts)
  })

  it('syncs new events', async () => {
    const postPromise = makePosts()

    const readAfterDelay = async () => {
      await wait(200) // wait just a hair so that we catch it during cutover
      const ws = new WebSocket(
        `ws://${serverHost}/xrpc/com.atproto.sync.subscribeRepos?cursor=${-1}`,
      )
      const evts = await readTillCaughtUp(byFrame(ws), postPromise)
      ws.terminate()
      return evts
    }

    const [evts] = await Promise.all([readAfterDelay(), postPromise])

    await verifyEvents(evts)
  })

  it('handles no backfill', async () => {
    const ws = new WebSocket(
      `ws://${serverHost}/xrpc/com.atproto.sync.subscribeRepos`,
    )

    const makePostsAfterWait = async () => {
      // give them just a second to get subscriptions set up
      await wait(200)
      await makePosts()
    }

    const postPromise = makePostsAfterWait()

    const [evts] = await Promise.all([
      readTillCaughtUp(byFrame(ws), postPromise),
      postPromise,
    ])

    ws.terminate()

    expect(evts.length).toBe(40)
  })

  it('backfills only from provided cursor', async () => {
    const seqs = await db.db
      .selectFrom('repo_seq')
      .selectAll()
      .orderBy('seq', 'asc')
      .execute()
    const midPoint = Math.floor(seqs.length / 2)
    const midPointSeq = seqs[midPoint].seq

    const ws = new WebSocket(
      `ws://${serverHost}/xrpc/com.atproto.sync.subscribeRepos?cursor=${midPointSeq}`,
    )
    const evts = await readTillCaughtUp(byFrame(ws))
    ws.terminate()
    const seqSlice = seqs.slice(midPoint + 1)
    expect(evts.length).toBe(seqSlice.length)
    for (let i = 0; i < evts.length; i++) {
      const evt = evts[i].body as CommitEvt
      const seq = seqSlice[i]
      expect(evt.time).toEqual(seq.sequencedAt)
      expect(evt.commit.toString()).toEqual(seq.commit)
      expect(evt.repo).toEqual(seq.did)
    }
  })

  it('sends info frame on out of date cursor', async () => {
    // we stick three new seqs in with a date past the backfill cutoff
    // then we increment the sequence number of everything else to test out of date cursor
    const cid = await cidForCbor({ test: 123 })
    const overAnHourAgo = new Date(Date.now() - HOUR - MINUTE).toISOString()
    const dummySeq = {
      did: 'did:example:test',
      commit: cid.toString(),
      eventType: 'repo_append' as const,
      sequencedAt: overAnHourAgo,
    }
    const newRows = await db.db
      .insertInto('repo_seq')
      .values([dummySeq, dummySeq, dummySeq])
      .returning('seq')
      .execute()
    const newSeqs = newRows.map((r) => r.seq)
    const movedToFuture = await db.db
      .updateTable('repo_seq')
      .set({ seq: sql`seq+1000` })
      .where('seq', 'not in', newSeqs)
      .returning('seq')
      .execute()

    const ws = new WebSocket(
      `ws://${serverHost}/xrpc/com.atproto.sync.subscribeRepos?cursor=${newSeqs[0]}`,
    )
    const [info, ...evts] = await readTillCaughtUp(byFrame(ws))
    ws.terminate()

    if (!(info instanceof MessageFrame)) {
      throw new Error('Expected first frame to be a MessageFrame')
    }
    expect(info.header.t).toBe('#info')
    const body = info.body as Record<string, unknown>
    expect(body.name).toEqual('OutdatedCursor')
    expect(evts.length).toBe(movedToFuture.length)
  })

  it('errors on future cursor', async () => {
    const ws = new WebSocket(
      `ws://${serverHost}/xrpc/com.atproto.sync.subscribeRepos?cursor=${100000}`,
    )
    const frames = await readTillCaughtUp(byFrame(ws))
    ws.terminate()
    expect(frames.length).toBe(1)
    if (!(frames[0] instanceof ErrorFrame)) {
      throw new Error('Expected ErrorFrame')
    }
    expect(frames[0].body.error).toBe('FutureCursor')
  })
})