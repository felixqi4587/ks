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

const COORDINATION_ASSETS = new Set(["/rally", "/defense"]);
const LEGACY_RALLY_PATHS = new Set(["/kvk", "/kvk.html"]);
const COORDINATION_METHODS = "GET, HEAD";

function safeUniqueQuery(searchParams, key, validate) {
  const values = searchParams.getAll(key);
  if (values.length !== 1 || !validate(values[0])) return null;
  return values[0];
}

function safeBuildQuery(value) {
  if (!/^[1-9]\d{0,15}$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function legacyRallyLocation(url) {
  const target = new URLSearchParams();
  const room = safeUniqueQuery(url.searchParams, "room", value => /^[A-Za-z0-9_-]{1,48}$/.test(value));
  const lang = safeUniqueQuery(url.searchParams, "lang", value => value === "en" || value === "zh");
  const notour = safeUniqueQuery(url.searchParams, "notour", value => value === "1");
  const build = safeUniqueQuery(url.searchParams, "__kvk_build", safeBuildQuery);
  if (room !== null) target.set("room", room);
  if (lang !== null) target.set("lang", lang);
  if (notour !== null) target.set("notour", notour);
  if (build !== null) target.set("__rally_build", String(Number(build)));
  const query = target.toString();
  return "/rally" + (query ? "?" + query : "");
}

function coordinationMethodNotAllowed() {
  return new Response(null, {
    status: 405,
    headers: {
      "Allow": COORDINATION_METHODS,
      "Cache-Control": "no-store"
    }
  });
}

function legacyRallyRedirect(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return coordinationMethodNotAllowed();
  return new Response(null, {
    status: 302,
    headers: {
      "Location": legacyRallyLocation(url),
      "Cache-Control": "no-store"
    }
  });
}

async function coordinationAsset(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return coordinationMethodNotAllowed();
  const response = await env.ASSETS.fetch(request);
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (LEGACY_RALLY_PATHS.has(url.pathname)) return legacyRallyRedirect(request, url);
    if (COORDINATION_ASSETS.has(url.pathname)) {
      return coordinationAsset(request, env);
    }

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
