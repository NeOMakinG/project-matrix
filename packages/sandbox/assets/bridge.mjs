// Runs INSIDE the sandbox. Exposes the per-run unix sockets on loopback TCP so unmodified CLIs can use them:
//   127.0.0.1:18080 -> llm.sock (model gateway, run token only)
//   127.0.0.1:18081 -> egress.sock (HTTPS CONNECT proxy, allowlisted hosts only)
import fs from "node:fs";
import net from "node:net";

const dir = process.env.MATRIX_SOCKET_DIR || "/run/matrix";
const readyFile = process.env.MATRIX_READY_FILE || "/tmp/.matrix-bridge-ready";
const routes = [
  [18080, "llm.sock"],
  [18081, "egress.sock"],
].filter(([, name]) => fs.existsSync(`${dir}/${name}`));

let pending = routes.length;
const ready = () => fs.writeFileSync(readyFile, "");
if (pending === 0) ready();
for (const [port, name] of routes) {
  net
    .createServer((client) => {
      const upstream = net.connect(`${dir}/${name}`);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
      client.pipe(upstream);
      upstream.pipe(client);
    })
    .listen(port, "127.0.0.1", () => {
      pending -= 1;
      if (pending === 0) ready();
    });
}
