# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

xchain-hub is a Node.js service that acts as an oracle for cryptocurrency pricing information and handles cross-chain action processing. It exposes a JSON-RPC API and syncs configuration data to connected "slave" hub instances.

## Commands

```bash
# Install dependencies
npm install

# Start the API server (port set by HUB_PORT in .env)
npm run api

# Docker build and run
docker build -t xchain-hub .
docker run -v /your/data/path:/data xchain-hub
```

There is no test runner configured in this project.

## Architecture

The service is composed of three files in `src/`:

- **`api.js`** — Entry point. Loads `.env`, initializes `XChainHub`, and starts an Express server on `HUB_PORT` (env var) with JSON-RPC routing via `express-json-rpc-router`. Also reads `HUB_HOST` from env. JSON-RPC methods exposed: `ping`, `getallconfigs`, `updateconfig`.

- **`XChainHub.js`** — Core hub class. Wraps the database layer and provides config management. Configs are structured as `{coin} → {network} → {module} → {paramName}`. Valid parameter names are defined in `PARAMETER_LIST`: `host`, `port`, `service_port`, `db_host`, `db_port`, `name`, `user`, `pass`.

- **`LevelUpDb.js`** — LevelDB persistence layer using `levelup`/`leveldown`. The database is opened from `/data/{dbName}` (the Docker container mounts a volume at `/data/`). Keys follow the format `P:{coin}-{network}-{module}:{paramName}`.

## Key Details

- The LevelDB database path is hardcoded to `/data/xchain-hub`. When running outside Docker, ensure `/data/` exists and is writable.
- A `.env` file is required at the project root (gitignored). The `dotenv` package loads it in `api.js`.
- The `axios` default timeout is set to 5000ms in `XChainHub.js` for future oracle/RPC calls.
- The Dockerfile copies `.env` using a glob pattern (`.en[v]`) to avoid Docker errors when the file is absent at build time.
