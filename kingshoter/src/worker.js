/* kingshoter — one Worker: static frontend + /api/* + per-room Durable Object.
   /api/ws   → the room's DO (WebSocket realtime)
   /api/lookup?fid= → PlayerID -> in-game name (official API)
   /api/codes → public read-only active gift codes
   /api/g/*  → hidden gift auto-redeem (small team only; see gift.js)
   everything else → static assets (public/). */
export { Room } from "./room.js";
import { lookupName } from "./ksapi.js";
import { handleGift, giftScheduled } from "./gift.js";
import { buildMetadata } from "./client-build.js";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/build") {
      return new Response(JSON.stringify(buildMetadata(
        env.TRIPLE_RALLY_ENABLED === "1",
        env.TRIPLE_RALLY_QA_ENABLED === "1"
      )), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, max-age=0",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (url.pathname === "/api/ws") {
      // rooms are keyed by ROOM NAME ONLY (kingdom number dropped 2026-07): "r:" prefix keeps the
      // namespace disjoint from every legacy "<kingdom>:<room>" DO, so old rooms are simply unreachable
      const room = (url.searchParams.get("room") || "_").slice(0, 48);
      const id = env.ROOM.idFromName("r:" + room);
      return env.ROOM.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/api/g/")) {
      return handleGift(url.pathname.slice(6), request, env, ctx);
    }

    if (url.pathname === "/api/lookup") {
      return json(await lookupName(url.searchParams.get("fid")));
    }

    // server time — clients NTP-sync to this so countdowns ignore a wrong device clock
    if (url.pathname === "/api/time") {
      return json({ t: Date.now() });
    }

    if (url.pathname === "/api/codes") {
      // public, read-only: active codes straight from the gift tool's KV (no redemption, no cross-Worker call)
      try {
        const raw = await env.GIFT_KV.get("codeDB");
        const db = raw ? JSON.parse(raw) : {};
        return json({ codes: Object.keys(db).filter(c => db[c].status === "active") });
      } catch (e) { return json({ codes: [] }); }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    return giftScheduled(event, env, ctx);
  }
};
