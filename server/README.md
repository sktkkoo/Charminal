# Calling service repository

The managed Cloudflare calling service and the legacy Node.js signaling broker
are maintained in the separate `Yorishiro-peer-call-server` Git repository. The local
checkout is a sibling of this application checkout. The GitHub repository is
private (`sktkkoo/yorishiro-peer-call-server`); the new managed service's license
remains undecided.

This application owns the call client and a copy of the
[v2 protocol contract](../src/runtime/peer-call/managed-protocol.md). Coordinate
wire changes and record both tested commits; server releases do not require an
application release when the protocol remains compatible.

For the legacy local broker, install dependencies in the server checkout and run
`npm run dev:legacy` there. Its tests and runbook are under `legacy/`.

Managed service development uses `npm run dev` in the server checkout. Operator
setup, TURN credentials, public deployment, and a default endpoint in the app's
distribution build remain separate rollout work. No public server is implied by
the client implementation or local tests.

From the server checkout, test a compatible app checkout with:

```sh
APP_REPO=/absolute/path/to/Charminal npm run test:client
```
