import { Server } from '../../../../lexicon'
import AppContext from '../../../../context'
import { authPassthru } from '../../../proxy'

export default function (server: Server, ctx: AppContext) {
  server.com.atproto.admin.getRecord({
    auth: ctx.authVerifier.role,
    handler: async ({ req, params }) => {
      const { data: recordDetailAppview } =
        await ctx.moderationAgent.com.atproto.admin.getRecord(
          params,
          authPassthru(req),
        )
      return {
        encoding: 'application/json',
        body: recordDetailAppview,
      }
    },
  })
}
