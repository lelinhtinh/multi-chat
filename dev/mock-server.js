const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.MC_MOCK_PORT ? Number(process.env.MC_MOCK_PORT) : 8787;

const subscriptions = new Map();
const wsClients = new Set();
const sseClients = new Set();

const jsonResponse = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
};

const broadcast = (payload) => {
  const message = JSON.stringify(payload);
  wsClients.forEach((socket) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(message);
    }
  });
  const sseData = `data: ${message}\n\n`;
  sseClients.forEach((res) => res.write(sseData));
};

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/subscribe") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        if (!data?.serviceId || !data?.subscription) {
          jsonResponse(res, 400, { ok: false, reason: "invalid_payload" });
          return;
        }
        subscriptions.set(data.subscription.endpoint, data);
        jsonResponse(res, 200, { ok: true, total: subscriptions.size });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, reason: err.message });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/broadcast") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const payload = {
          title: data.title || "Mock notice",
          body: data.body || new Date().toISOString(),
          serviceId: data.serviceId || "local-test",
          emittedAt: Date.now()
        };
        broadcast(payload);
        jsonResponse(res, 200, { ok: true, delivered: wsClients.size + sseClients.size });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, reason: err.message });
      }
    });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/events")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    jsonResponse(res, 200, { ok: true, subscriptions: subscriptions.size, wsClients: wsClients.size });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, reason: "not_found" }));
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket) => {
  wsClients.add(socket);
  socket.send(JSON.stringify({ type: "hello", serviceId: "local-test", emittedAt: Date.now() }));
  socket.on("message", (data) => {
    let payload = null;
    try {
      payload = JSON.parse(data.toString());
    } catch (_err) {
      payload = { echo: data.toString() };
    }
    broadcast({ ...payload, serviceId: payload?.serviceId || "local-test", emittedAt: Date.now() });
  });
  socket.on("close", () => wsClients.delete(socket));
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/notifications") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[mock-server] listening on http://localhost:${PORT}`);
});
