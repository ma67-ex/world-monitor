// Second consolidated dispatcher, same pattern as
// api/domain-gateway/[domain]/v1/[...rest].ts and api/misc-gateway/[name].ts
// -- see the former's header comment for the full rationale (Vercel Hobby's
// 12-function cap, why this can't live at the api/ root).
//
// This one covers the remaining nested-path standalone endpoints (varying
// depth -- discord/oauth/callback, internal/mcp-grant-mint, etc.).
//
// NOT a [...path] filesystem catch-all (that was the bug -- see below).
// Plain file, no dynamic segment: /api/misc-gateway2 always resolves to
// this function, and vercel.json passes the target key as `?key=`.
//
// Why: Vercel's file-based routing for a bare (non-Next.js) Edge/Serverless
// [...path].ts generates a SINGLE-SEGMENT match regex (`^/api/misc-gateway2/
// ([^/]+)$`) even though the directory name uses the "...spread" catch-all
// convention -- it does not become a true multi-segment splat outside
// Next.js. Every key in REGISTRY below is 2+ segments (e.g.
// 'discord/oauth/callback'), so that generated route could never match and
// every request 404'd at the platform level before reaching this file (#7014
// -- confirmed via `vercel build` + inspecting .vercel/output/config.json's
// resolved `routes`; misc-gateway/[name].ts a few files over is unaffected
// because its keys are always exactly one segment). A query param sidesteps
// Vercel's path-segment regex entirely.
export const config = { runtime: 'edge' };

import briefShareUrlHandler from './brief/_share-url';
import discordOauthCallbackHandler from './discord/oauth/_callback';
import discordOauthStartHandler from './discord/oauth/_start';
import internalBriefWhyMattersHandler from './internal/_brief-why-matters';
import internalMcpGrantContextHandler from './internal/_mcp-grant-context';
import internalMcpGrantMintHandler from './internal/_mcp-grant-mint';
import meEntitlementHandler from './me/_entitlement';
import oauthAuthorizeProHandler from './oauth/_authorize-pro';
// @ts-expect-error — JS module, no declaration file
import oauthAuthorizeHandler from './oauth/_authorize';
// @ts-expect-error — JS module, no declaration file
import oauthRegisterHandler from './oauth/_register';
import oauthTokenHandler from './oauth/_token';
import referralMeHandler from './referral/_me';
// @ts-expect-error — JS module, no declaration file
import securityReportHandler from './security/_report';
import skillsFetchAgentskillsHandler from './skills/_fetch-agentskills';
import slackOauthCallbackHandler from './slack/oauth/_callback';
import slackOauthStartHandler from './slack/oauth/_start';
import userMcpQuotaHandler from './user/_mcp-quota';
import userMcpRevokeHandler from './user/_mcp-revoke';
// @ts-expect-error — JS module, no declaration file
import youtubeEmbedHandler from './youtube/_embed';
// @ts-expect-error — JS module, no declaration file
import youtubeLiveHandler from './youtube/_live';
// @ts-expect-error — JS module, no declaration file
import supplyChainHormuzTrackerHandler from './supply-chain/_hormuz-tracker';
import desktopAuthAuthorizeHandler from './desktop-auth/_authorize';
import desktopAuthTokenHandler from './desktop-auth/_token';
import desktopKeyStatusHandler from './desktop-key/_status';
import embedEntitlementHandler from './embed/_entitlement';
import embedMapFrameHandler from './embed/_map-frame';
import embedSessionHandler from './embed/_session';
import userPasskeyOfferHandler from './user/_passkey-offer';
import latestBriefHandler from './_latest-brief';
import mdTwinHandler from './_md-twin';
// @ts-expect-error — JS module, no declaration file
import openDataChokepointsHandler from './_open-data-chokepoints';

import { createDomainGateway, serverOptions } from '../server/gateway';
import { createIntelligenceServiceRoutes as intelligenceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { intelligenceHandler } from '../server/worldmonitor/intelligence/v1/handler';
import orbitalGateway from './orbital/v1/_rpc';

type EdgeCtx = { waitUntil: (p: Promise<unknown>) => void };
type EdgeHandler = (req: Request, ctx: EdgeCtx) => Response | Promise<Response>;

const REGISTRY: Record<string, EdgeHandler> = {
  'brief/share-url': briefShareUrlHandler,
  'discord/oauth/callback': discordOauthCallbackHandler,
  'discord/oauth/start': discordOauthStartHandler,
  'internal/brief-why-matters': internalBriefWhyMattersHandler,
  'internal/mcp-grant-context': internalMcpGrantContextHandler,
  'internal/mcp-grant-mint': internalMcpGrantMintHandler,
  'me/entitlement': meEntitlementHandler,
  'oauth/authorize-pro': oauthAuthorizeProHandler,
  'oauth/authorize': oauthAuthorizeHandler,
  'oauth/register': oauthRegisterHandler,
  'oauth/token': oauthTokenHandler,
  'referral/me': referralMeHandler,
  'security/report': securityReportHandler,
  'skills/fetch-agentskills': skillsFetchAgentskillsHandler,
  'slack/oauth/callback': slackOauthCallbackHandler,
  'slack/oauth/start': slackOauthStartHandler,
  'user/mcp-quota': userMcpQuotaHandler,
  'user/mcp-revoke': userMcpRevokeHandler,
  'youtube/embed': youtubeEmbedHandler,
  'youtube/live': youtubeLiveHandler,
  'desktop-auth/authorize': desktopAuthAuthorizeHandler,
  'desktop-auth/token': desktopAuthTokenHandler,
  'desktop-key/status': desktopKeyStatusHandler,
  'embed/entitlement': embedEntitlementHandler,
  'embed/map-frame': embedMapFrameHandler,
  'embed/session': embedSessionHandler,
  'user/passkey-offer': userPasskeyOfferHandler,
  'latest-brief': latestBriefHandler,
  'md-twin': mdTwinHandler,
  'open-data-chokepoints': openDataChokepointsHandler,
  'supply-chain/hormuz-tracker': supplyChainHormuzTrackerHandler,
  // Domain gateways moved out of api/domain-gateway to keep it under 1 MB.
  // They route on the original pathname, which Vercel rewrites preserve.
  intelligence: createDomainGateway(intelligenceRoutes(intelligenceHandler, serverOptions)),
  orbital: orbitalGateway,
};

export default async function handler(req: Request, ctx: EdgeCtx): Promise<Response> {
  const url = new URL(req.url);
  // vercel.json rewrites the client-facing URL to
  // /api/misc-gateway2?key=<registry-key> (see vercel.json's
  // misc-gateway2 rewrite block). The key travels as a query param, not a
  // path segment, so it can contain slashes without hitting Vercel's
  // single-segment route-matching limit (see file header comment).
  const key = url.searchParams.get('key') ?? '';
  const target = REGISTRY[key];
  if (!target) {
    return new Response(JSON.stringify({ error: `Unknown endpoint: ${key}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return target(req, ctx);
}
