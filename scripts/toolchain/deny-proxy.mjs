// Local proxy that refuses every outbound request and records what was attempted (owner decision D5).
import http from 'node:http';

export async function startDenyProxy() {
  const attempts = [];
  const server = http.createServer((req, res) => {
    attempts.push({ method: req.method, target: req.url });
    res.writeHead(403, { connection: 'close' });
    res.end();
  });
  server.on('connect', (req, socket) => {
    // A client may reset the connection after the refusal; that must not crash the proxy.
    socket.on('error', () => undefined);
    attempts.push({ method: 'CONNECT', target: req.url });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    attempts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
