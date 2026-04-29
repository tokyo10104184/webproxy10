import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 8080);
const MAX_REDIRECTS = 10;

const cookieStore = new Map();

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailers", "transfer-encoding", "upgrade", "host", "content-length"
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "frame-options", "cross-origin-opener-policy", "cross-origin-embedder-policy"
]);

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function toProxyUrl(value) {
  return `/proxy?url=${encodeURIComponent(value)}`;
}

function mergeSetCookie(origin, setCookieValues = []) {
  if (!setCookieValues.length) return;
  const existing = cookieStore.get(origin) || [];
  const newCookies = setCookieValues.map((v) => v.split(";")[0]);
  const merged = [...existing.filter((old) => !newCookies.some((v) => old.startsWith(v.split("=")[0] + "="))), ...newCookies];
  cookieStore.set(origin, merged);
}

function getCookieHeader(origin) {
  const cookies = cookieStore.get(origin);
  return cookies?.length ? cookies.join("; ") : "";
}

function rewriteCss(css, baseUrl) {
  return css
    .replace(/url\(([^)]+)\)/gi, (match, raw) => {
      const clean = raw.trim().replace(/^['"]|['"]$/g, "");
      if (!clean || /^(data:|blob:|javascript:)/i.test(clean)) return match;
      try {
        return `url(${JSON.stringify(toProxyUrl(new URL(clean, baseUrl).toString()))})`;
      } catch {
        return match;
      }
    })
    .replace(/@import\s+['"]([^'"]+)['"]/gi, (match, raw) => {
      try {
        return `@import ${JSON.stringify(toProxyUrl(new URL(raw, baseUrl).toString()))}`;
      } catch {
        return match;
      }
    });
}

function injectRuntime(html, baseUrl) {
  const runtime = `
<script>
(() => {
  const PROXY = ${JSON.stringify(`${process.env.PUBLIC_PROXY_BASE || ""}/proxy?url=`)};
  const BASE_URL = ${JSON.stringify(baseUrl)};
  const abs = (value) => { try { return new URL(value, BASE_URL).toString(); } catch { return value; } };
  const proxyUrl = (value) => PROXY + encodeURIComponent(abs(value));
  const attrs = ["src", "href", "action", "poster", "data", "srcset"];

  const rewriteAttr = (el, attr) => {
    if (!el?.getAttribute || !el.hasAttribute(attr)) return;
    const val = el.getAttribute(attr);
    if (!val || val.startsWith("#") || /^(data:|blob:|javascript:)/i.test(val)) return;
    if (attr === "srcset") {
      const rewritten = val.split(",").map((part) => {
        const bits = part.trim().split(/\\s+/);
        const u = bits.shift();
        return u ? proxyUrl(u) + (bits.length ? " " + bits.join(" ") : "") : part;
      }).join(", ");
      el.setAttribute(attr, rewritten);
      return;
    }
    el.setAttribute(attr, proxyUrl(val));
  };

  const rewriteTree = (root) => {
    if (!(root instanceof Element)) return;
    attrs.forEach((a) => rewriteAttr(root, a));
    root.querySelectorAll("[src],[href],[action],[poster],[data],[srcset]").forEach((el) => attrs.forEach((a) => rewriteAttr(el, a)));
  };

  rewriteTree(document.documentElement);
  new MutationObserver((list) => {
    list.forEach((m) => {
      if (m.type === "attributes") rewriteTree(m.target);
      m.addedNodes.forEach((n) => rewriteTree(n));
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: attrs });

  const patchArg = (arg) => {
    if (typeof arg !== "string") return arg;
    if (/^(data:|blob:|javascript:|about:)/i.test(arg)) return arg;
    return proxyUrl(arg);
  };

  const nativeFetch = window.fetch;
  window.fetch = (input, init = {}) => {
    if (typeof input === "string") return nativeFetch(patchArg(input), init);
    if (input instanceof Request) return nativeFetch(new Request(patchArg(input.url), input), init);
    return nativeFetch(input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return xhrOpen.call(this, method, patchArg(url), ...rest); };
})();
</script>`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${baseUrl}">\n${runtime}`);
  }
  return `${runtime}\n${html}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function proxyFetch(targetUrl, req, bodyBuffer, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) throw new Error("Too many redirects");

  const target = new URL(targetUrl);
  const outboundHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== "origin") {
      outboundHeaders[key] = value;
    }
  }
  outboundHeaders.host = target.host;
  outboundHeaders.referer = target.origin;

  const cookieHeader = getCookieHeader(target.origin);
  if (cookieHeader) outboundHeaders.cookie = cookieHeader;

  const method = req.method || "GET";
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  if (hasBody && bodyBuffer?.length) outboundHeaders["content-length"] = String(bodyBuffer.length);

  const response = await fetch(targetUrl, {
    method,
    headers: outboundHeaders,
    body: hasBody ? bodyBuffer : undefined,
    redirect: "manual"
  });

  mergeSetCookie(target.origin, response.headers.getSetCookie?.() || []);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (location) return proxyFetch(new URL(location, targetUrl).toString(), req, bodyBuffer, redirectCount + 1);
  }

  return { response, target };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (reqUrl.pathname === "/health") {
    const payload = JSON.stringify({ ok: true, service: "webproxy10", now: new Date().toISOString() });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(payload);
  }

  if (reqUrl.pathname === "/proxy") {
    const targetUrl = reqUrl.searchParams.get("url");
    if (!targetUrl || !isHttpUrl(targetUrl)) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Missing or invalid ?url= parameter." }));
    }

    try {
      const bodyBuffer = await readBody(req);
      const { response, target } = await proxyFetch(targetUrl, req, bodyBuffer);
      const ctype = response.headers.get("content-type") || "application/octet-stream";
      const headers = {};

      for (const [key, value] of response.headers.entries()) {
        const lower = key.toLowerCase();
        if (BLOCKED_RESPONSE_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower) || lower === "set-cookie") continue;
        if (lower === "location") {
          headers[key] = toProxyUrl(new URL(value, target.toString()).toString());
        } else {
          headers[key] = value;
        }
      }

      if (ctype.includes("text/html")) {
        const rewritten = injectRuntime(await response.text(), target.toString());
        headers["content-type"] = "text/html; charset=utf-8";
        res.writeHead(response.status, headers);
        return res.end(rewritten);
      }

      if (ctype.includes("text/css")) {
        const rewritten = rewriteCss(await response.text(), target.toString());
        res.writeHead(response.status, headers);
        return res.end(rewritten);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, headers);
      return res.end(buffer);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Proxy request failed", details: String(error.message || error) }));
    }
  }

  const safePath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const fullPath = path.join(publicDir, safePath);
  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await fs.readFile(fullPath);
    res.writeHead(200, { "content-type": contentType(fullPath) });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`webproxy10 listening on http://localhost:${PORT}`);
});
