import { Server } from '../../../../lexicon'
import AppContext from '../../../../context'
import { OutputSchema } from '../../../../lexicon/types/app/bsky/feed/getAuthorFeed'
import { handleReadAfterWrite } from '../util/read-after-write'
import { LocalRecords } from '../../../../services/local'
import {
  authPassthru,
  proxy,
  proxyAppView,
  resultPassthru,
} from '../../../proxy'

export default function (server: Server, ctx: AppContext) {
  server.app.bsky.feed.getActorLikes({
    auth: ctx.authVerifier.accessOrRole,
    handler: async ({ req, params, auth }) => {
      if (auth.credentials.type === 'access') {
        const proxied = await proxy(
          ctx,
          auth.credentials.audience,
          async (agent) => {
            const result = await agent.api.app.bsky.feed.getActorLikes(
              params,
              authPassthru(req),
            )
            return resultPassthru(result)
          },
        )
        if (proxied !== null) {
          return proxied
        }
      }

      const requester =
        auth.credentials.type === 'access' ? auth.credentials.did : null

      const res = await proxyAppView(ctx, async (agent) =>
        agent.api.app.bsky.feed.getActorLikes(
          params,
          requester
            ? await ctx.appviewAuthHeaders(requester)
            : authPassthru(req),
        ),
      )
      if (requester) {
        return await handleReadAfterWrite(ctx, requester, res, getAuthorMunge)
      }
      return {
        encoding: 'application/json',
        body: res.data,
      }
    },
  })
}

const getAuthorMunge = async (
  ctx: AppContext,
  original: OutputSchema,
  local: LocalRecords,
  requester: string,
): Promise<OutputSchema> => {
  const localSrvc = ctx.services.local(ctx.db)
  const localProf = local.profile
  let feed = original.feed
  // first update any out of date profile pictures in feed
  if (localProf) {
    feed = feed.map((item) => {
      if (item.post.author.did === requester) {
        return {
          ...item,
          post: {
            ...item.post,
            author: localSrvc.updateProfileViewBasic(
              item.post.author,
              localProf.record,
            ),
          },
        }
      } else {
        return item
      }
    })
  }
  return {
    ...original,
    feed,
  }
}
