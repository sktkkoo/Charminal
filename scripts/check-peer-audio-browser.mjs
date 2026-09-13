#!/usr/bin/env node
// Run with Node, open the printed local URL, and click Run. This fixture uses only
// synthesized audio and local WebRTC; it never opens a microphone or a provider.
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const route = "/__peer-audio-check";
const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Peer audio separation check</title>
<style>
body{font:16px system-ui;margin:32px;max-width:1100px;background:#f7f7f5;color:#171717}
button{font:inherit;padding:12px 24px}table{border-collapse:collapse;margin:20px 0;width:100%}
th,td{text-align:left;border:1px solid #aaa;padding:8px}pre{white-space:pre-wrap;font-size:13px}
.pass{color:#08712d}.fail{color:#b51b1b}
</style>
<h1>Peer audio separation check</h1>
<p>Two real local WebRTC endpoints, with synthetic human and AI tones only.
Microphone access is replaced inside this page. Playback is muted.</p>
<button id="run" type="button">Run synthetic check</button>
<h2 id="status" role="status">Ready</h2>
<table><thead><tr><th>Phase</th><th>Remote human RMS</th><th>Remote AI RMS</th>
<th>Provider input RMS</th><th>Remote mouth</th><th>Own provider input RMS</th></tr></thead>
<tbody id="phases"></tbody></table>
<pre id="result"></pre>
<script type="module" src="/scripts/lib/peer-audio-browser.mjs"></script></html>`;

const server = await createServer({
  configFile: false,
  root,
  cacheDir: "node_modules/.vite-peer-audio-check",
  optimizeDeps: { entries: ["scripts/lib/peer-audio-browser.mjs"] },
  server: {
    host: "127.0.0.1",
    port: 5179,
    open: false,
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
  plugins: [
    {
      name: "peer-audio-check-page",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url?.split("?")[0] !== route) return next();
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(html);
        });
      },
    },
  ],
});
await server.listen();
const address = server.httpServer.address();
console.log(`Peer audio check: http://127.0.0.1:${address.port}${route}`);
console.log("Open this URL and click Run synthetic check. Stop the server with Ctrl-C.");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
