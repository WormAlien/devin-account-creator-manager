// Keepalive proxy respawner. Replaces keepalive-proxy.js on :20133 the same way
// transparent-proxy.js does it: child_process.spawn(detached, stdio:'ignore'),
// so the launching console returns immediately and the child survives.
// Usage: node keepalive-spawn.js
'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 20133;
const FILE = path.join(__dirname, 'keepalive-proxy.js');

// 1) Kill whatever currently listens on :20133.
function killPort(port, cb) {
    const srv = net.createServer();
    srv.once('error', () => {
        // Port busy -> find PID via a TCP connect trick is not available without
        // extra deps; use netstat + taskkill instead.
        const { execFile } = require('child_process');
        execFile('netstat', ['-ano'], (err, out) => {
            if (err) return cb();
            const re = new RegExp(`:${port}\\s+.*LISTENING\\s+([0-9]+)`, 'g');
            const pids = new Set();
            let m;
            while ((m = re.exec(out))) pids.add(m[1]);
            if (pids.size === 0) return cb();
            let left = pids.size;
            for (const pid of pids) {
                execFile('taskkill', ['/F', '/PID', pid], () => {
                    left -= 1;
                    if (left === 0) setTimeout(cb, 500);
                });
            }
        });
    });
    srv.once('listening', () => { srv.close(() => cb()); });
    srv.listen(port, '127.0.0.1');
}

killPort(PORT, () => {
    const env = Object.assign({}, process.env, {
        PORT: String(PORT),
        UPSTREAM: 'https://agentrouter.org',
        IDLE_MS: '5000',
        MAX_RETRIES: '3',
        RETRY_DELAY_MS: '1500',
        COUNT_TOKENS_FALLBACK: '1',
        EARLY_SSE: '1',
        UPSTREAM_TIMEOUT_MS: '600000',
        HAIKU_REMAP: '1',
        HAIKU_TO_MODEL: 'gpt-5.6-sol',
        HAIKU_GPT_PROXY: 'http://127.0.0.1:20132',
        LOG_FILE: path.join(__dirname, 'keepalive-proxy.log'),
    });
    const child = spawn(process.execPath, [FILE], {
        detached: true,
        stdio: 'ignore',
        env,
    });
    child.unref();
    console.log(`keepalive spawn: pid ${child.pid}`);
    process.exit(0);
});
