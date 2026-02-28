import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTaggerPlugin } from "./src/visual-edits/component-tagger-plugin.js";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import { URL } from "node:url";

const PROXY_ROUTES = new Set(["/__proxy/hls", "/api/hls-proxy"]);
const REFERERS = ["https://hianime.to/", "https://megacloud.com/"];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const base64UrlEncode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const base64UrlDecode = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
};

const decodeTargetUrl = (requestUrl: URL) => {
  const b64 = requestUrl.searchParams.get("b64");
  const url = requestUrl.searchParams.get("url");

  const decoded = b64 ? base64UrlDecode(b64) : url ? decodeURIComponent(url) : "";
  if (!decoded) {
    throw new Error("Missing target URL");
  }

  const parsed = new URL(decoded);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Only HTTP(S) URLs are supported");
  }

  return parsed.toString();
};

const shouldRewriteManifest = (targetUrl: string, contentType: string | undefined) => {
  if (targetUrl.toLowerCase().includes(".m3u8")) {
    return true;
  }

  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return normalized.includes("application/vnd.apple.mpegurl") || normalized.includes("application/x-mpegurl");
};

const rewriteManifest = (manifest: string, manifestUrl: string) => {
  return manifest
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line;
      }

        const absoluteUrl = new URL(trimmed, manifestUrl).toString();
        const proxied = `/api/hls-proxy?b64=${base64UrlEncode(absoluteUrl)}`;
        return line.replace(trimmed, proxied);
    })
    .join("\n");
};

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const setCorsHeaders = (res: http.ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,Content-Type");
};

const proxyRequest = (
  targetUrl: string,
  referer: string,
  clientReq: http.IncomingMessage,
  redirectCount = 0,
): Promise<IncomingMessage> => {
  if (redirectCount > 5) {
    return Promise.reject(new Error("Too many redirects"));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    const requestHeaders: Record<string, string> = {
      "user-agent": USER_AGENT,
      referer,
      origin: new URL(referer).origin,
      accept: typeof clientReq.headers.accept === "string" ? clientReq.headers.accept : "*/*",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "identity",
    };

    if (typeof clientReq.headers.range === "string") {
      requestHeaders.range = clientReq.headers.range;
    }

    const options: RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: requestHeaders,
    };

    const upstreamReq = transport.request(options, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode ?? 500;
      const location = upstreamRes.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        upstreamRes.resume();
        const redirectedTo = new URL(location, parsed.toString()).toString();
        proxyRequest(redirectedTo, referer, clientReq, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      resolve(upstreamRes);
    });

    upstreamReq.on("error", reject);
    upstreamReq.end();
  });
};

const streamWithProxy = async (
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  targetUrl: string,
) => {
  let upstreamRes: IncomingMessage | null = null;

  for (const referer of REFERERS) {
    upstreamRes = await proxyRequest(targetUrl, referer, clientReq);
    const statusCode = upstreamRes.statusCode ?? 500;

    if (statusCode !== 403) {
      break;
    }

    upstreamRes.resume();
    upstreamRes = null;
  }

  if (!upstreamRes) {
    clientRes.statusCode = 403;
    clientRes.end("Forbidden by upstream server");
    return;
  }

  const statusCode = upstreamRes.statusCode ?? 500;
  const contentType = Array.isArray(upstreamRes.headers["content-type"])
    ? upstreamRes.headers["content-type"][0]
    : upstreamRes.headers["content-type"];

  setCorsHeaders(clientRes);

  if (shouldRewriteManifest(targetUrl, contentType)) {
    const chunks: Buffer[] = [];
    upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamRes.on("error", (error) => {
      clientRes.statusCode = 502;
      clientRes.end(`Proxy stream error: ${error.message}`);
    });

    upstreamRes.on("end", () => {
      const manifest = Buffer.concat(chunks).toString("utf8");
      const rewritten = rewriteManifest(manifest, targetUrl);
      clientRes.statusCode = statusCode;
      clientRes.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      clientRes.setHeader("Cache-Control", "no-store");
      clientRes.end(rewritten);
    });
    return;
  }

  clientRes.statusCode = statusCode;

  Object.entries(upstreamRes.headers).forEach(([key, value]) => {
    if (!value || hopByHopHeaders.has(key.toLowerCase())) {
      return;
    }

    if (key.toLowerCase() === "access-control-allow-origin") {
      return;
    }

    clientRes.setHeader(key, value as string | string[]);
  });

  upstreamRes.pipe(clientRes);
};

const hlsProxyPlugin = () => ({
  name: "hls-proxy-plugin",
  configureServer(server: { middlewares: { use: (fn: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) => void } }) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url) {
        next();
        return;
      }

      const parsedUrl = new URL(req.url, "http://localhost");
        if (!PROXY_ROUTES.has(parsedUrl.pathname)) {
        next();
        return;
      }

      setCorsHeaders(res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      try {
        const targetUrl = decodeTargetUrl(parsedUrl);
        await streamWithProxy(req, res, targetUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown proxy error";
        res.statusCode = 400;
        res.end(`Invalid proxy request: ${message}`);
      }
    });
  },
});

const logErrorsPlugin = () => ({
  name: "log-errors-plugin",
  transformIndexHtml() {
    return {
      tags: [
        {
          tag: "script",
          injectTo: "head",
          children: `(() => {
            try {
              const logOverlay = () => {
                const el = document.querySelector('vite-error-overlay');
                if (!el) return;
                const root = (el.shadowRoot || el);
                let text = '';
                try { text = root.textContent || ''; } catch (_) {}
                if (text && text.trim()) {
                  const msg = text.trim();
                  console.error('[Vite Overlay]', msg);
                  try {
                    if (window.parent && window.parent !== window) {
                      window.parent.postMessage({
                        type: 'ERROR_CAPTURED',
                        error: {
                          message: msg,
                          stack: undefined,
                          filename: undefined,
                          lineno: undefined,
                          colno: undefined,
                          source: 'vite.overlay',
                        },
                        timestamp: Date.now(),
                      }, '*');
                    }
                  } catch (_) {}
                }
              };

              const obs = new MutationObserver(() => logOverlay());
              obs.observe(document.documentElement, { childList: true, subtree: true });

              window.addEventListener('DOMContentLoaded', logOverlay);
              logOverlay();
            } catch (e) {
              console.warn('[Vite Overlay logger failed]', e);
            }
          })();`
        }
      ]
    };
  },
});

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 3000,
  },
  plugins: [
    react(),
    hlsProxyPlugin(),
    logErrorsPlugin(),
    mode === "development" && componentTaggerPlugin(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
