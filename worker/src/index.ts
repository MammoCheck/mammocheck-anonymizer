// Cloudflare Worker: holds the Google Drive credentials, hands out folder IDs and resumable upload sessions.
// File bytes never pass through here: the browser PUTs chunks straight to the Drive session URL.

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DRIVE_FOLDER_ID: string;
  UPLOAD_KEY: string;
  ALLOWED_ORIGIN: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE = "https://www.googleapis.com/drive/v3";
const MAX_DEPTH = 10;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- small helpers ----
const allowedOrigins = (env: Env) =>
  env.ALLOWED_ORIGIN.split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Upload-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(origin ? corsHeaders(origin) : {}) },
  });
}

/** Constant-time comparison (hash both sides so lengths match). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// ---- Google auth (access token cached per isolate) ----
let token: { value: string; expires: number } | undefined;

async function accessToken(env: Env): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new HttpError(502, `Google token refresh failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function drive<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(DRIVE + path, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new HttpError(502, `Drive request failed (${res.status})`);
  return (await res.json()) as T;
}

// Folder IDs known to be inside the root (found/created by this isolate, or verified by walking parents).
const insideRoot = new Set<string>();

async function isUnderRoot(env: Env, id: string): Promise<boolean> {
  if (id === env.DRIVE_FOLDER_ID || insideRoot.has(id)) return true;
  const chain: string[] = [];
  let cur = id;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const f = await drive<{ id: string; parents?: string[] }>(env, `/files/${encodeURIComponent(cur)}?fields=id,parents&supportsAllDrives=true`);
    chain.push(f.id);
    const parent = f.parents?.[0];
    if (!parent) return false;
    if (parent === env.DRIVE_FOLDER_ID || insideRoot.has(parent)) {
      chain.forEach((c) => insideRoot.add(c));
      return true;
    }
    cur = parent;
  }
  return false;
}

async function findOrCreateFolder(env: Env, parent: string, name: string): Promise<string> {
  const query = `name=${q(name)} and ${q(parent)} in parents and mimeType=${q(FOLDER_MIME)} and trashed=false`;
  const list = await drive<{ files: { id: string }[] }>(env, `/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  let id = list.files[0]?.id;
  if (!id) {
    const created = await drive<{ id: string }>(env, `/files?fields=id&supportsAllDrives=true`, {
      method: "POST",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    });
    id = created.id;
  }
  insideRoot.add(id);
  return id;
}

// ---- handlers ----
const validName = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 255 && !/[\\/\0]/.test(s);

async function handleFolder(env: Env, body: any): Promise<unknown> {
  const path = body?.path;
  if (!Array.isArray(path) || path.length === 0 || path.length > MAX_DEPTH || !path.every(validName)) throw new HttpError(400, "bad path");
  let parent = env.DRIVE_FOLDER_ID;
  for (const name of path) parent = await findOrCreateFolder(env, parent, name);
  return { id: parent };
}

async function handleSession(env: Env, origin: string, body: any): Promise<unknown> {
  const { parentId, name, mimeType, size } = body ?? {};
  if (typeof parentId !== "string" || !/^[\w-]{5,100}$/.test(parentId)) throw new HttpError(400, "bad parentId");
  if (!validName(name)) throw new HttpError(400, "bad name");
  if (typeof mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new HttpError(400, "bad mimeType");
  if (!Number.isInteger(size) || size < 0) throw new HttpError(400, "bad size");
  if (!(await isUnderRoot(env, parentId))) throw new HttpError(403, "parent is outside the configured folder");

  // re-run safe: same name + same size already there -> skip
  const query = `name=${q(name)} and ${q(parentId)} in parents and trashed=false`;
  const existing = await drive<{ files: { size?: string }[] }>(env, `/files?q=${encodeURIComponent(query)}&fields=files(size)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  if (existing.files.some((f) => f.size === String(size))) return { exists: true };

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken(env)}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(size),
      Origin: origin, // lets the browser PUT to the session URL cross-origin
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  const location = res.headers.get("Location");
  if (!res.ok || !location) throw new HttpError(502, `Drive session failed (${res.status})`);
  return { location };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    const originOk = allowedOrigins(env).includes(origin);

    if (request.method === "OPTIONS") {
      return originOk ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      const configured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN && env.DRIVE_FOLDER_ID && env.UPLOAD_KEY && env.ALLOWED_ORIGIN);
      return json({ ok: true, configured }, 200, originOk ? origin : undefined);
    }
    if (request.method !== "POST" || (url.pathname !== "/folder" && url.pathname !== "/session")) return json({ error: "not found" }, 404);
    if (!originOk) return json({ error: "origin not allowed" }, 403);

    try {
      const key = request.headers.get("X-Upload-Key") ?? "";
      if (!env.UPLOAD_KEY || !(await safeEqual(key, env.UPLOAD_KEY))) throw new HttpError(401, "bad upload key");
      const body = await request.json().catch(() => null);
      const out = url.pathname === "/folder" ? await handleFolder(env, body) : await handleSession(env, origin, body);
      return json(out, 200, origin);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
      return json({ error: "internal error" }, 500, origin);
    }
  },
} satisfies ExportedHandler<Env>;
