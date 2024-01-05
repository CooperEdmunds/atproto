import { Server } from '../../../../lexicon'
import AppContext from '../../../../context'
import { authPassthru, proxy, proxyAppView } from '../../../proxy'

export default function (server: Server, ctx: AppContext) {
  server.app.bsky.graph.unmuteActorList({
    auth: ctx.authVerifier.access,
    handler: async ({ auth, input, req }) => {
      const proxied = await proxy(
        ctx,
        auth.credentials.audience,
        async (agent) => {
          await agent.api.app.bsky.graph.unmuteActorList(
            input.body,
            authPassthru(req, true),
          )
        },
      )
      if (proxied !== null) {
        return proxied
      }

      const requester = auth.credentials.did
      await proxyAppView(ctx, async (agent) =>
        agent.api.app.bsky.graph.unmuteActorList(input.body, {
          ...(await ctx.appviewAuthHeaders(requester)),
          encoding: 'application/json',
        }),
      )
    },
  })
}
