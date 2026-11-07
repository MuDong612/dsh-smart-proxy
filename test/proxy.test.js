import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSelectiveProxy,
  makeMatcher,
  parseUpstream,
  splitHostPort,
} from "../lib/proxy.js";
import { BLOCK_START, DOMESTIC_NO_PROXY, removeHarnessEnv, syncHarnessEnv } from "../lib/env.js";

async function startEcho() {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startFakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const forwarded = http.request(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    forwarded.on("error", () => res.writeHead(502).end());
    req.pipe(forwarded);
  });

  server.on("connect", (req, clientSocket, head) => {
    seen.push(req.url);
    const index = req.url.lastIndexOf(":");
    const host = req.url.slice(0, index);
    const port = Number(req.url.slice(index + 1));
    const target = net.connect({ host, port }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) target.write(head);
      clientSocket.pipe(target);
      target.pipe(clientSocket);
    });
    target.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => target.destroy());
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function connectVia(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: target,
    });
    request.on("connect", (res, socket) => resolve({ status: res.statusCode, socket }));
    request.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, socket: null });
    });
    request.on("error", reject);
    request.end();
  });
}

function roundTrip(socket, text) {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(chunk.toString()));
    socket.once("error", reject);
    socket.write(text);
  });
}

test("makeMatcher 做后缀匹配，且不误伤相似域名", () => {
  const matches = makeMatcher(["google.com", "*.openai.com", "claude.ai"]);
  assert.equal(matches("www.google.com"), true);
  assert.equal(matches("google.com"), true);
  assert.equal(matches("notgoogle.com"), false);
  assert.equal(matches("api.openai.com"), true);
  assert.equal(matches("openai.com"), false);
  assert.equal(matches("claude.ai"), true);
  assert.equal(matches(""), false);
});

test("splitHostPort 支持 IPv6 与缺省端口", () => {
  assert.deepEqual(splitHostPort("example.com:8443"), { host: "example.com", port: 8443 });
  assert.deepEqual(splitHostPort("[::1]:443"), { host: "::1", port: 443 });
  assert.deepEqual(splitHostPort("example.com"), { host: "example.com", port: 443 });
  assert.deepEqual(splitHostPort("[2001:db8::1]"), { host: "2001:db8::1", port: 443 });
});

test("parseUpstream 解析地址与认证", () => {
  assert.deepEqual(parseUpstream("http://127.0.0.1:7890"), {
    host: "127.0.0.1",
    port: 7890,
    authHeader: undefined,
    display: "127.0.0.1:7890",
  });
  const withAuth = parseUpstream("http://user:pass@127.0.0.1:7890");
  assert.equal(withAuth.authHeader, `Basic ${Buffer.from("user:pass").toString("base64")}`);
});

test("命中白名单的 CONNECT 走上游，未命中的直连", async () => {
  const echo = await startEcho();
  const upstream = await startFakeUpstream();
  const throughUpstream = createSelectiveProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstream.port}`,
    patterns: ["127.0.0.1"],
  });
  const directProxy = createSelectiveProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstream.port}`,
    patterns: [],
  });
  try {
    const proxiedAddress = await throughUpstream.listen();
    const viaProxy = await connectVia(proxiedAddress.port, `127.0.0.1:${echo.port}`);
    assert.equal(viaProxy.status, 200);
    assert.equal(await roundTrip(viaProxy.socket, "proxied"), "proxied");
    viaProxy.socket.destroy();
    assert.deepEqual(upstream.seen, [`127.0.0.1:${echo.port}`]);

    const directAddress = await directProxy.listen();
    const direct = await connectVia(directAddress.port, `127.0.0.1:${echo.port}`);
    assert.equal(direct.status, 200);
    assert.equal(await roundTrip(direct.socket, "direct"), "direct");
    direct.socket.destroy();
    assert.deepEqual(upstream.seen, [`127.0.0.1:${echo.port}`]);
  } finally {
    await throughUpstream.close();
    await directProxy.close();
    await upstream.close();
    await echo.close();
  }
});

test("enabled=false 时全部直连", async () => {
  const echo = await startEcho();
  const upstream = await startFakeUpstream();
  const proxy = createSelectiveProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstream.port}`,
    patterns: ["127.0.0.1"],
    enabled: false,
  });
  try {
    const address = await proxy.listen();
    const result = await connectVia(address.port, `127.0.0.1:${echo.port}`);
    assert.equal(result.status, 200);
    assert.equal(await roundTrip(result.socket, "off"), "off");
    result.socket.destroy();
    assert.deepEqual(upstream.seen, []);
  } finally {
    await proxy.close();
    await upstream.close();
    await echo.close();
  }
});

test("上游不可用时白名单返回 502，直连不受影响", async () => {
  const echo = await startEcho();
  const proxied = createSelectiveProxy({
    port: 0,
    upstream: "http://127.0.0.1:1",
    patterns: ["127.0.0.1"],
  });
  const directProxy = createSelectiveProxy({
    port: 0,
    upstream: "http://127.0.0.1:1",
    patterns: [],
  });
  try {
    const proxiedAddress = await proxied.listen();
    const failed = await connectVia(proxiedAddress.port, `127.0.0.1:${echo.port}`);
    assert.equal(failed.status, 502);

    const directAddress = await directProxy.listen();
    const direct = await connectVia(directAddress.port, `127.0.0.1:${echo.port}`);
    assert.equal(direct.status, 200);
    assert.equal(await roundTrip(direct.socket, "still-ok"), "still-ok");
    direct.socket.destroy();
  } finally {
    await proxied.close();
    await directProxy.close();
    await echo.close();
  }
});

test("明文 HTTP 请求可以直连转发", async () => {
  const target = http.createServer((req, res) => res.end(`ok:${req.url}`));
  await new Promise((resolve) => target.listen(0, "0.0.0.0", resolve));
  const targetPort = target.address().port;

  const proxy = createSelectiveProxy({ port: 0, upstream: "http://127.0.0.1:1", patterns: [] });
  try {
    const address = await proxy.listen();
    const result = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: `http://127.0.0.1:${targetPort}/hello?x=1`,
          headers: { host: `127.0.0.1:${targetPort}` },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, "ok:/hello?x=1");
  } finally {
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test("同步 .env：保留用户变量、写入托管块、可重复执行", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smart-proxy-"));
  const envPath = path.join(home, ".env");
  fs.writeFileSync(
    envPath,
    "GEMINI_API_KEY=keep-me\nHTTP_PROXY=http://127.0.0.1:7890\nNO_PROXY=foo.com\n",
    "utf8",
  );

  try {
    const first = syncHarnessEnv({ home, port: 17890 });
    assert.equal(first.changed, true);
    assert.ok(first.backupPath);

    const content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /GEMINI_API_KEY=keep-me/);
    assert.match(content, /HTTP_PROXY=http:\/\/127\.0\.0\.1:17890/);
    assert.match(content, /NODE_USE_ENV_PROXY=1/);
    assert.match(content, new RegExp(BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(first.noProxy.includes("foo.com"));
    assert.ok(first.noProxy.includes("deepseek.com"));
    assert.deepEqual([...DOMESTIC_NO_PROXY].every((entry) => content.includes(entry)), true);

    const second = syncHarnessEnv({ home, port: 17890 });
    assert.equal(second.changed, false);
    assert.equal(fs.readFileSync(envPath, "utf8"), content);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("removeHarnessEnv 清除托管块并保留用户变量", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smart-proxy-off-"));
  const envPath = path.join(home, ".env");
  fs.writeFileSync(envPath, "GEMINI_API_KEY=keep-me\n", "utf8");

  try {
    syncHarnessEnv({ home, port: 17890 });
    assert.match(fs.readFileSync(envPath, "utf8"), /HTTP_PROXY=/);

    const removed = removeHarnessEnv({ home });
    assert.equal(removed.changed, true);
    const content = fs.readFileSync(envPath, "utf8");
    assert.doesNotMatch(content, /HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY/);
    assert.doesNotMatch(content, /dsh-smart-proxy managed block/);
    assert.match(content, /GEMINI_API_KEY=keep-me/);
    assert.ok(fs.existsSync(removed.backupPath));

    assert.equal(removeHarnessEnv({ home }).changed, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolve 让路由随配置实时变化", async () => {
  const echo = await startEcho();
  const upstreamA = await startFakeUpstream();
  const upstreamB = await startFakeUpstream();
  let runtime = {
    enabled: false,
    upstream: `http://127.0.0.1:${upstreamA.port}`,
    patterns: ["127.0.0.1"],
  };
  const proxy = createSelectiveProxy({ port: 0, resolve: () => runtime });
  try {
    const address = await proxy.listen();

    const direct = await connectVia(address.port, `127.0.0.1:${echo.port}`);
    assert.equal(direct.status, 200);
    assert.equal(await roundTrip(direct.socket, "off"), "off");
    direct.socket.destroy();
    assert.deepEqual(upstreamA.seen, []);

    runtime = { ...runtime, enabled: true };
    const proxied = await connectVia(address.port, `127.0.0.1:${echo.port}`);
    assert.equal(proxied.status, 200);
    assert.equal(await roundTrip(proxied.socket, "on"), "on");
    proxied.socket.destroy();
    assert.deepEqual(upstreamA.seen, [`127.0.0.1:${echo.port}`]);

    runtime = { ...runtime, upstream: `http://127.0.0.1:${upstreamB.port}` };
    const moved = await connectVia(address.port, `127.0.0.1:${echo.port}`);
    assert.equal(moved.status, 200);
    assert.equal(await roundTrip(moved.socket, "b"), "b");
    moved.socket.destroy();
    assert.deepEqual(upstreamB.seen, [`127.0.0.1:${echo.port}`]);
  } finally {
    await proxy.close();
    await upstreamA.close();
    await upstreamB.close();
    await echo.close();
  }
});
