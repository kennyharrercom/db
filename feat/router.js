//chatgpt generated router example
import cluster from "node:cluster";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";
import XXH from "xxhashjs";

// ---------------- Config ----------------
const PORT = Number(process.env.PORT ?? 8080);
const MANIFEST_PATH = process.env.MANIFEST_PATH ?? "./manifest.json";
const SEED = 0xABCD1234;
const VIRTUAL_SHARDS = 65_536n; // 2^16
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS ?? 15_000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 12_000);
const RETRY_SECONDARY = (process.env.RETRY_SECONDARY ?? "false") === "true";
const PRESERVE_HOST = (process.env.PRESERVE_HOST ?? "false") === "true"; // keep original Host when proxying

// Routing key behavior: "path" | "header"
const ROUTE_KEY_MODE = (process.env.ROUTE_KEY_MODE ?? "path").toLowerCase();
// Optional: strip a fixed prefix before hashing, e.g. "/api"
const ROUTE_STRIP_PREFIX = process.env.ROUTE_STRIP_PREFIX ?? "";

// ---------------- Hashing ----------------
function vsidFromKey(key) {
  const h64 = BigInt("0x" + XXH.h64(key, SEED).toString(16));
  return Number(h64 % VIRTUAL_SHARDS); // 0..65535
}

// ---------------- Parent process ----------------
if (cluster.isPrimary) {
  let manifest = loadManifestOrExit(MANIFEST_PATH);
  broadcastManifest(manifest);

  // Watch manifest for hot reload
  let timer = null;
  fs.watch(MANIFEST_PATH, { persistent: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const next = loadManifestOrExit(MANIFEST_PATH, /*soft*/ true);
        if (next.version !== manifest.version) {
          manifest = next;
          console.log(`[parent] manifest -> v${manifest.version}`);
          broadcastManifest(manifest);
        }
      } catch (e) {
        console.error("[parent] reload error:", e.message);
      }
    }, 150);
  });

  // Fork workers
  const n = Number(process.env.WORKERS ?? os.cpus().length);
  for (let i = 0; i < n; i++) cluster.fork();

  cluster.on("exit", (w, code, sig) => {
    console.warn(`[parent] worker ${w.process.pid} exited (${code || sig}); restarting`);
    cluster.fork();
  });

  function broadcastManifest(m) {
    for (const id in cluster.workers) {
      cluster.workers[id].send({ type: "manifest", payload: m });
    }
  }

  function loadManifestOrExit(path, soft = false) {
    const raw = fs.readFileSync(path, "utf8");
    const m = JSON.parse(raw);

    if (
      typeof m.version !== "number" ||
      typeof m.virtual_shards !== "number" ||
      !m.assignments || !m.nodes
    ) {
      throw new Error("manifest missing required fields");
    }
    const ranges = Object.entries(m.assignments)
      .map(([k, node]) => {
        const [s, e] = k.split("-").map(Number);
        return { s, e, node };
      })
      .sort((a, b) => a.s - b.s);

    if (ranges.length === 0 || ranges[0].s !== 0 || ranges.at(-1).e !== m.virtual_shards - 1) {
      throw new Error("assignments must cover [0, virtual_shards-1]");
    }
    for (const r of ranges) {
      if (!m.nodes[r.node]) throw new Error(`assignment references unknown node ${r.node}`);
    }
    return { ...m, _ranges: ranges };
  }

  console.log(`[parent] dist-proxy :${PORT} workers=${n}`);
  return;
}

// ---------------- Worker (HTTP/WS proxy) ----------------
let CURRENT_MANIFEST = null;

// keep-alive agents
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 2048 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 2048 });

process.on("message", (msg) => {
  if (msg?.type === "manifest") {
    CURRENT_MANIFEST = hydrateManifest(msg.payload);
    console.log(`[worker ${process.pid}] manifest v${CURRENT_MANIFEST.version} loaded`);
  }
});

function hydrateManifest(m) {
  const fast = new Array(m.virtual_shards);
  for (const { s, e, node } of m._ranges ?? []) {
    for (let v = s; v <= e; v++) fast[v] = node;
  }
  return { ...m, _fast: fast };
}

// Core server
const server = http.createServer();

// Support 100-continue (for large uploads)
server.on("checkContinue", (req, res) => {
  res.writeContinue();
  handleHttp(req, res);
});

// Standard requests
server.on("request", handleHttp);

// WebSocket / upgrade
server.on("upgrade", (req, socket, head) => {
  // Choose routing key same as HTTP
  const { key, vsid, nodeName, nodeInfo } = resolveRouting(req);
  if (!nodeInfo) {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstreamUrl = new URL(nodeInfo.url);
  const port = Number(upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80));
  const host = upstreamUrl.hostname;

  // TCP tunnel to upstream, then forward upgrade
  const upstream = net.connect(port, host, () => {
    // Write the original request line and headers to upstream
    let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    // Copy headers; optionally override Host
    const rawHeaders = req.rawHeaders.slice();
    if (!PRESERVE_HOST) {
      // replace Host with upstream host
      const idx = rawHeaders.findIndex((h) => h.toLowerCase() === "host");
      if (idx >= 0) {
        rawHeaders[idx + 1] = upstreamUrl.host;
      } else {
        rawHeaders.push("Host", upstreamUrl.host);
      }
    }
    // Add proxy metadata
    rawHeaders.push("X-Dir-Version", String(CURRENT_MANIFEST.version));
    rawHeaders.push("X-Vsid", String(vsid));
    rawHeaders.push("X-Target-Node", nodeName);

    for (let i = 0; i < rawHeaders.length; i += 2) {
      headers += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
    }
    headers += "\r\n";
    upstream.write(headers);
    // Send any upgrade head bytes
    if (head && head.length) upstream.write(head);
    // Pipe both ways
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
  });
});

server.keepAliveTimeout = 12_000;
server.headersTimeout = 14_000;
server.requestTimeout = REQ_TIMEOUT_MS;

server.listen(PORT, () => {
  console.log(`[worker ${process.pid}] listening :${PORT}`);
});

// ------------- HTTP handler -------------
function handleHttp(req, res) {
  if (req.url === "/healthz") {
    if (!CURRENT_MANIFEST) {
      res.writeHead(503, { "Content-Type": "text/plain" }).end("manifest not loaded");
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    }
    return;
  }

  const { key, vsid, nodeName, nodeInfo } = resolveRouting(req);
  if (!nodeInfo) {
    res.writeHead(502, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "manifest not loaded or vsid unassigned" }));
    return;
  }

  // Build target URL: keep original path + query exactly
  const upstreamBase = new URL(nodeInfo.url);
  const isHttps = upstreamBase.protocol === "https:";
  const agent = isHttps ? agentHttps : agentHttp;

  // Compose headers: copy literally everything, with safe hop-by-hop removals
  const headers = Object.fromEntries(req.rawHeaders.reduce((acc, val, i, arr) => {
    if (i % 2 === 0) acc.push([arr[i], arr[i + 1]]);
    return acc;
  }, []));
  // Normalize header keys to avoid duplicates
  // Remove hop-by-hop per RFC 7230; these must not be forwarded
  delete headers["Proxy-Connection"];
  delete headers["proxy-connection"];
  delete headers["Connection"];
  delete headers["connection"];
  delete headers["Keep-Alive"];
  delete headers["keep-alive"];
  delete headers["TE"];
  delete headers["te"];
  delete headers["Trailer"];
  delete headers["trailer"];
  delete headers["Transfer-Encoding"]; // Node will set correctly
  delete headers["upgrade"];
  delete headers["Upgrade"];

  // Host handling
  if (!PRESERVE_HOST) {
    headers["Host"] = upstreamBase.host;
  }

  // Forwarding headers
  const clientIp = req.socket.remoteAddress || "";
  headers["X-Forwarded-For"] = headers["X-Forwarded-For"]
    ? `${headers["X-Forwarded-For"]}, ${clientIp}`
    : clientIp;
  headers["X-Forwarded-Proto"] = isHttps ? "https" : "http";
  headers["X-Forwarded-Host"] = headers["Host"] ?? req.headers.host;

  // Routing metadata
  headers["X-Dir-Version"] = String(CURRENT_MANIFEST.version);
  headers["X-Vsid"] = String(vsid);
  headers["X-Target-Node"] = nodeName;

  const opts = {
    protocol: upstreamBase.protocol,
    hostname: upstreamBase.hostname,
    port: upstreamBase.port || (isHttps ? 443 : 80),
    method: req.method,
    path: req.url, // preserve exact path + query
    headers,
    agent,
    timeout: UPSTREAM_TIMEOUT_MS,
  };

  const mod = isHttps ? https : http;
  const upstream = mod.request(opts, (up) => {
    // Mirror status and headers back to client
    const respHeaders = { ...up.headers };
    respHeaders["X-Dir-Version"] = String(CURRENT_MANIFEST.version);
    respHeaders["X-Vsid"] = String(vsid);
    respHeaders["X-Target-Node"] = nodeName;

    res.writeHead(up.statusCode || 502, respHeaders);
    up.pipe(res);
  });

  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    if (!RETRY_SECONDARY) return fail(res, 502, `upstream error: ${err.message}`);
    const alt = findSecondaryNode(vsid, CURRENT_MANIFEST, nodeName);
    if (!alt) return fail(res, 502, `upstream error: ${err.message}`);
    // Retry once to a different node (best-effort)
    const altBase = new URL(alt.info.url);
    const altOpts = { ...opts, hostname: altBase.hostname, port: altBase.port || (altBase.protocol === "https:" ? 443 : 80), protocol: altBase.protocol };
    const altMod = altBase.protocol === "https:" ? https : http;
    const altReq = altMod.request(altOpts, (up2) => {
      const respHeaders2 = { ...up2.headers };
      respHeaders2["X-Target-Node"] = alt.name;
      res.writeHead(up2.statusCode || 502, respHeaders2);
      up2.pipe(res);
    });
    altReq.on("error", (e2) => fail(res, 502, `secondary upstream error: ${e2.message}`));
    req.pipe(altReq);
  });

  // Stream the request body verbatim
  req.pipe(upstream);
}

function resolveRouting(req) {
  if (!CURRENT_MANIFEST) return { key: null, vsid: null, nodeName: null, nodeInfo: null };

  // 1) If caller provides an explicit key, use it
  let key = req.headers["x-route-key"];
  if (!key) {
    // 2) Default to the full decoded path (path-type DBs). Example: "/users/userdata/tapeUser"
    if (ROUTE_KEY_MODE === "path") {
      const fake = new URL(req.url, "http://x"); // base required
      let pathname = decodeURIComponent(fake.pathname);
      if (ROUTE_STRIP_PREFIX && pathname.startsWith(ROUTE_STRIP_PREFIX)) {
        pathname = pathname.slice(ROUTE_STRIP_PREFIX.length) || "/";
      }
      key = pathname;
    } else {
      // Fallback: header mode requires x-route-key
      key = "";
    }
  }
  key = String(key);

  const vsid = vsidFromKey(key);
  const nodeName = CURRENT_MANIFEST._fast[vsid];
  const nodeInfo = nodeName ? CURRENT_MANIFEST.nodes[nodeName] : null;
  return { key, vsid, nodeName, nodeInfo };
}

function findSecondaryNode(vsid, m, primaryName) {
  let next = (vsid + 1) % m.virtual_shards;
  for (let attempts = 0; attempts < m.virtual_shards; attempts++) {
    const name = m._fast[next];
    if (name && name !== primaryName) return { name, info: m.nodes[name] };
    next = (next + 1) % m.virtual_shards;
  }
  return null;
}

function fail(res, code, msg) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { "Content-Type": "application/json" })
     .end(JSON.stringify({ error: msg }));
}

process.on("uncaughtException", (e) => console.error(`[worker ${process.pid}] uncaught`, e));
process.on("unhandledRejection", (e) => console.error(`[worker ${process.pid}] unhandled`, e));
