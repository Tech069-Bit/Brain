# Neural Link — Windows Native Companion Bridge (Phase 6)

This is the piece Phase 5 flagged as missing: a small native process
that runs on your own PC and can see real Windows-API-level system
data — hardware, OS, processes, installed software, files — which a
browser tab can never reach on its own. It hands that data to the
Brain PWA **only after you pair it with a one-time token**, and
**only over localhost**.

## What this is / isn't

- It **is** a local, read-only inventory agent, in the same category
  as tools like HWMonitor, Task Manager, or an IT asset-management
  agent — it reads system state, it doesn't change anything.
- It **is not** a remote-access tool, a keylogger, or anything that
  runs without you starting it. Closing the console window stops it.
- It **cannot** be reached from another machine, another network, or
  another website. It only listens on `127.0.0.1`.

## Setup

1. Install [Node.js 18+](https://nodejs.org) if you don't have it.
2. In this folder:
   ```
   npm install
   npm start
   ```
3. The console prints a pairing token, e.g.:
   ```
   Pairing token (paste into the Brain app):
     a1b2c3d4e5f6...
   ```
4. In the Brain app's **PC CONNECTOR (PHASE 5)** card, paste that
   token into the "Native bridge pairing token" field, then click
   **CONNECT THIS PC**. The connector will show `CONNECTED` (native
   bridge) instead of `LIMITED` (browser-only), and capabilities
   like `hardware.full`, `processes.list`, and `software.installed`
   move from unavailable to supported.
5. Stop the bridge any time with `Ctrl+C` or by closing the window.
   The Brain app falls back to browser-only data automatically — it
   never assumes the bridge is still there.

A new random token is generated every time you start the bridge and
is never written to disk. Treat it like a password for the duration
it's on screen: anything on your machine that has the token can read
everything this bridge exposes.

## Security model

- **Localhost-only.** The server binds to `127.0.0.1`, never to your
  network interface. There's no config flag to change that.
- **Token-required.** Every endpoint except `/ping` requires
  `Authorization: Bearer <token>`, checked with a constant-time
  comparison. `/ping` itself returns only a hostname + timestamp
  handshake, no system data, so the app can detect "is a bridge
  running" before you've pasted anything in.
- **Read-only.** No endpoint writes, deletes, renames, kills a
  process, or executes user-supplied commands. The installed-software
  list is read via a fixed, read-only PowerShell query against the
  standard Uninstall registry keys — the same data Control Panel's
  "Programs and Features" shows.
- **No privilege escalation.** Runs as whatever normal user account
  starts it — it only sees what that account could already see in
  Explorer or Task Manager. No UAC bypass, no service install.
- **On-demand file access only.** `/files?path=...` lists exactly one
  folder you name, non-recursively. `/drives` lists drive
  letters and free/used space, never file contents. There's no
  "scan everything" endpoint.
- **Nothing hidden.** Runs in a visible console window, logs what
  it's doing, and doesn't add itself to startup, a scheduled task, or
  a Windows service — you'd have to set that up yourself separately.

## Endpoints (all `GET`, all require the bearer token except `/ping`)

| Endpoint | Returns |
|---|---|
| `/ping` | `{ pong, hostname, at }` — handshake only, no auth required |
| `/hardware` | CPU, memory, GPU, motherboard, BIOS, disk layout, battery |
| `/os` | OS name/version/build/arch, kernel/tool versions, boot time |
| `/network` | Network interfaces, nearby Wi-Fi networks, active connections |
| `/processes` | Running process list (same data as Task Manager's Details tab) |
| `/services` | Windows services and their status |
| `/software` | Installed applications (name, version, publisher, install date) |
| `/system-state` | Current CPU load, memory usage, filesystem I/O stats |
| `/drives` | Drive letters with size/used/free |
| `/files?path=<folder>` | Non-recursive listing of one folder: name, type, size, modified |

## Uninstalling

There's nothing to uninstall — delete this folder. The bridge never
installs itself anywhere else, writes to the registry, or adds a
startup entry.
