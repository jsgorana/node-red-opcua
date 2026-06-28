# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 - 2026-06-28

Initial pre-release of `@jsgorana/node-red-opcua`.

- Added client nodes: endpoint, read, write, browse, and subscribe.
- Added bidirectional `opcua-server` node for exposing Node-RED values.
- Added shared, ref-counted OPC-UA connection management with reconnect handling.
- Added fail-fast operation timeouts for read/write/browse workflows.
- Added secure-by-default client certificate validation with persisted PKI storage.
- Added username/password authentication and Sign/SignAndEncrypt server support.
- Added batch read/write support.
- Added shared endpoint subscriptions with per-node monitored items.
- Added subscribe deadband/data-change filter support.
- Added polished Node-RED example flows.
- Added automated tests, linting, and GitHub Actions CI.
