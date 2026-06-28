# Contributing

Thanks for helping improve `@jsgorana/node-red-opcua`.

## Requirements

- Node.js 22.9 or newer
- npm

## Local Setup

```bash
npm install
npm run lint
npm test
```

The test suite starts local OPC-UA servers as needed; no external OPC-UA server is required.

## Development Notes

- Keep runtime node files under `nodes/`.
- Keep shared logic in `nodes/lib/` where it can be tested without Node-RED.
- Add or update tests for behavioral changes.
- Preserve secure defaults. Development-only security bypasses should be explicit and logged.
- Do not publish from feature branches or local experiments.

## Before Opening a PR

```bash
npm run lint
npm test
```

Include a short description of the change, the reason for it, and any manual OPC-UA or
Node-RED validation performed.
