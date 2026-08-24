#!/usr/bin/env node
/**
 * Neural Link — Windows Native Companion Bridge (Phase 6)
 * ================================================================
 * This is the piece Phase 5 said didn't exist yet: a small native
 * process that can actually see Windows-API-level system data, and
 * hands a READ-ONLY summary to the Brain PWA over localhost once
 * you've pasted its pairing token into the app.
 *
 * SECURITY MODEL — read this before running it:
 *  - Binds to 127.0.0.1 ONLY. It never listens on your network
 *    interface, never accepts a remote connection, and there is no
 *    setting to change that in this file.
 *  - Every request must carry the pairing token this process prints
 *    on startup, as an `Authorization: Bearer <token>` header. A new
 *    random token is generated each time you start the bridge — it
 *    is never written to disk and never leaves this machine except
 *    by you pasting it into the Brain app yourself.
 *  - READ-ONLY. There is no endpoint that writes, deletes, renames,
 *    kills a process, changes a setting, or executes anything the
 *    user didn't already ask this script to run. `installed
 *    software` is read via a read-only registry query; nothing here
 *    calls into the registry to write.
 *  - Runs as whatever normal (non-admin) user account starts it. It
 *    only sees what that Windows account can already see in
 *    Explorer / Task Manager — no privilege escalation, no UAC
 *    bypass, no service installation.
 *  - File access is on-demand and scoped to one folder per request
 *    (`GET /files?path=...`) — this process never crawls a whole
 *    drive on its own. `GET /drives` only lists drive letters and
 *    free/used space, not file contents.
 *  - Nothing about this process hides itself: it prints to a normal
 *    console window, logs what it's doing, and stops the moment you
 *    close that window or hit Ctrl+C. It does not install itself as
 *    a scheduled task or auto-start — set that up yourself if you
 *    want it, this script won't do it silently.
 *
 * SETUP:
 *   1. Install Node.js 18+ (nodejs.org) if you don't have it.
 *   2. In this folder:  npm install
 *   3. Run it:           npm start
 *   4. Copy the pairing token it prints into the Brain app's
 *      "Native bridge pairing token" field, then click
 *      "Connect this PC".
 *   5. Close the console window (or Ctrl+C) any time to stop it —
 *      the Brain app falls back to browser-only data automatically.
 * ================================================================ */
'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let si;
try { si = require('systeminformation'); }
catch (e){
  console.error('Missing dependency "systeminformation". Run "npm install" in this folder first.');
  process.exit(1);
}

const PORT = Number(process.env.BRAIN_BRIDGE_PORT) || 8765;
const HOST = '127.0.0.1'; // never change this to 0.0.0.0 — localhost-only is the whole security model
const TOKEN = crypto.randomBytes(20).toString('hex');

console.log('==========================================================');
console.log(' Neural Link — Windows Native Companion Bridge (Phase 6)');
console.log('==========================================================');
console.log(' Pairing token (paste into the Brain app):');
console.log('   ' + TOKEN);
console.log('');
console.log(` Listening on http://${HOST}:${PORT} (this machine only)`);
console.log(' Read-only. Ctrl+C to stop. Nothing persists after that.');
console.log('==========================================================');

function checkAuth(req){
  const auth = req.headers['authorization'] || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // constant-time compare so token length/content isn't leaked via timing
  const a = Buffer.from(provided.padEnd(TOKEN.length, '\0'));
  const b = Buffer.from(TOKEN.padEnd(TOKEN.length, '\0'));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && provided.length === TOKEN.length;
}

function corsHeaders(req){
  const origin = req.headers['origin'] || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    // Chrome's Private Network Access check — required for an https
    // page to fetch a plain-http localhost endpoint.
    'Access-Control-Allow-Private-Network': 'true'
  };
}

function send(res, status, body, extraHeaders){
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
  res.end(JSON.stringify(body));
}

/* ---- read-only installed-software query. Reads the standard
   Uninstall registry keys via PowerShell Get-ItemProperty — the
   same mechanism Control Panel's "Programs and Features" uses. No
   write, no execution of arbitrary user input (path is fixed). ---- */
function listInstalledSoftware(){
  return new Promise((resolve) => {
    const psCmd = [
      'Get-ItemProperty',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
      'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      '-ErrorAction SilentlyContinue |',
      'Where-Object { $_.DisplayName } |',
      'Select-Object DisplayName, DisplayVersion, Publisher, InstallDate |',
      'ConvertTo-Json -Compress'
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { maxBuffer: 1024 * 1024 * 16, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve({ items: [], note: 'PowerShell query failed or unavailable: ' + err.message });
        try {
          const parsed = JSON.parse(stdout || '[]');
          resolve({ items: Array.isArray(parsed) ? parsed : [parsed] });
        } catch (e){ resolve({ items: [], note: 'could not parse PowerShell output' }); }
      }
    );
  });
}

/* ---- on-demand single-folder listing. Never recurses, never
   called without an explicit path from the request. ---- */
function listFolder(targetPath){
  return new Promise((resolve, reject) => {
    fs.readdir(targetPath, { withFileTypes: true }, (err, entries) => {
      if (err) return reject(err);
      const out = entries.map((e) => {
        let stat = null;
        try { stat = fs.statSync(path.join(targetPath, e.name)); } catch (er){ /* permission-denied entries are skipped, not guessed at */ }
        return {
          name: e.name,
          isDirectory: e.isDirectory(),
          sizeBytes: stat ? stat.size : null,
          modified: stat ? stat.mtime.toISOString() : null
        };
      });
      resolve(out);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const headers = corsHeaders(req);
  if (req.method === 'OPTIONS') return send(res, 204, {}, headers); // preflight (incl. Private Network Access)

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/ping'){
    // /ping is intentionally unauthenticated at the transport level so
    // the app can detect "is a bridge here at all" — but it returns no
    // system data, only a hostname + timestamp handshake.
    return send(res, 200, { pong: true, hostname: os.hostname(), at: Date.now() }, headers);
  }

  if (!checkAuth(req)) return send(res, 401, { error: 'missing or invalid pairing token' }, headers);

  try {
    switch (url.pathname){
      case '/hardware': {
        const [cpu, mem, graphics, baseboard, bios, diskLayout, battery] = await Promise.all([
          si.cpu(), si.mem(), si.graphics(), si.baseboard(), si.bios(), si.diskLayout(), si.battery().catch(() => null)
        ]);
        return send(res, 200, { cpu, mem, graphics, baseboard, bios, diskLayout, battery }, headers);
      }
      case '/os': {
        const [osInfo, versions, time] = await Promise.all([si.osInfo(), si.versions(), si.time()]);
        return send(res, 200, { os: osInfo, versions, time }, headers);
      }
      case '/network': {
        const [interfaces, wifi, connections] = await Promise.all([
          si.networkInterfaces(), si.wifiNetworks().catch(() => []), si.networkConnections().catch(() => [])
        ]);
        return send(res, 200, { interfaces, wifi, connections }, headers);
      }
      case '/processes':
        return send(res, 200, await si.processes(), headers);
      case '/services':
        return send(res, 200, await si.services('*'), headers);
      case '/software':
        return send(res, 200, await listInstalledSoftware(), headers);
      case '/system-state': {
        const [load, mem, fsStats] = await Promise.all([si.currentLoad(), si.mem(), si.fsStats().catch(() => null)]);
        return send(res, 200, { load, mem, fsStats }, headers);
      }
      case '/drives':
        return send(res, 200, await si.fsSize(), headers);
      case '/files': {
        const target = url.searchParams.get('path');
        if (!target) return send(res, 400, { error: 'path query param required' }, headers);
        try { return send(res, 200, await listFolder(target), headers); }
        catch (e){ return send(res, 403, { error: 'cannot read path: ' + e.message }, headers); }
      }
      default:
        return send(res, 404, { error: 'unknown endpoint' }, headers);
    }
  } catch (e){
    return send(res, 500, { error: e.message }, headers);
  }
});

server.listen(PORT, HOST);

process.on('SIGINT', () => { console.log('\nStopping bridge — no data persists.'); process.exit(0); });
