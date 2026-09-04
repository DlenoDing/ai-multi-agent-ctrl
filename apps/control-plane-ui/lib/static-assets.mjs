import {existsSync, readFileSync, statSync} from "node:fs";
import {gzipSync} from "node:zlib";
import {extname, join, normalize} from "node:path";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export function createStaticAssetHandler(publicDir, options = {}) {
  const staticFileCache = new Map();
  const maxEntries = options.maxEntries || 64;

  return function serveStatic(req, res, pathname) {
    let requested = pathname === "/" ? "/index.html" : pathname;
    try {
      requested = decodeURIComponent(requested);
    } catch {
      res.writeHead(400, {"content-type": "text/plain; charset=utf-8"});
      res.end("Bad request");
      return;
    }
    const target = normalize(join(publicDir, requested));
    if ((target !== publicDir && !target.startsWith(`${publicDir}/`)) || !existsSync(target)) {
      res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
      res.end("Not found");
      return;
    }
    const stat = statSync(target);
    if (!stat.isFile()) {
      res.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
      res.end("Not found");
      return;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    let cached = staticFileCache.get(target);
    if (!cached || cached.stamp !== stamp) {
      const bytes = readFileSync(target);
      cached = {stamp, content: bytes, gzip: gzipSync(bytes)};
      if (staticFileCache.size > maxEntries) staticFileCache.clear();
      staticFileCache.set(target, cached);
    }
    const content = cached.content;
    const wantsGzip = /\bgzip\b/u.test(String(req.headers["accept-encoding"] || ""));
    const useGzip = wantsGzip && cached.gzip && cached.gzip.length < content.length;
    const etag = `"${cached.stamp}${useGzip ? "-gz" : ""}"`;
    const securityHeaders = {"x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'", "referrer-policy": "no-referrer",
      "cache-control": "no-cache", vary: "accept-encoding", etag,
      ...(useGzip ? {"content-encoding": "gzip"} : {})};
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, securityHeaders);
      res.end();
      return;
    }
    res.writeHead(200, {"content-type": mimeTypes[extname(target)] || "application/octet-stream", ...securityHeaders});
    res.end(useGzip ? cached.gzip : content);
  };
}
