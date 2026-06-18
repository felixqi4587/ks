/**
 * 1406rocks plan store — Cloudflare Worker + KV (v6)
 *
 * GET  /plan  -> public read: { plan, updatedAt, updatedBy }
 * POST /plan  -> admin write; body { password, name, plan, baseUpdatedAt }
 *               password === env.ADMIN_PASS ("666"); updatedBy = name.
 *               optimistic lock: if a plan exists and its updatedAt !==
 *               baseUpdatedAt -> 409 { error:"conflict", current }.
 *
 * Everyone who opens 1406rocks reads the same plan via GET /plan, so the
 * admin's published plan is the default everyone sees — no share link.
 */

const KEY = "plan";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/plan" && request.method === "GET") {
      const raw = await env.PLAN_KV.get(KEY);
      if (!raw) return json({ plan: null, updatedAt: null, updatedBy: null });
      try {
        return json(JSON.parse(raw));
      } catch {
        return json({ plan: null, updatedAt: null, updatedBy: null });
      }
    }

    if (url.pathname === "/plan" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      if (!body || body.password !== env.ADMIN_PASS) {
        return json({ error: "wrong password" }, 403);
      }
      if (body.plan == null || typeof body.plan !== "object") {
        return json({ error: "missing plan" }, 400);
      }
      const raw = await env.PLAN_KV.get(KEY);
      const current = raw ? JSON.parse(raw) : null;
      if (current && body.baseUpdatedAt !== undefined && current.updatedAt !== body.baseUpdatedAt) {
        return json({ error: "conflict", current }, 409);
      }
      const record = {
        plan: body.plan,
        updatedAt: new Date().toISOString(),
        updatedBy: (body.name || "").toString().slice(0, 24),
      };
      await env.PLAN_KV.put(KEY, JSON.stringify(record));
      return json({ ok: true, updatedAt: record.updatedAt, updatedBy: record.updatedBy });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({ ok: true, service: "1406rocks-plan-store" });
    }

    return json({ error: "not found" }, 404);
  },
};
