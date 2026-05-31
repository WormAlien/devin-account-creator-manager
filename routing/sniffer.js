// Sniffer router — logs full request headers + body for debugging.
// Routes everything to OmniRoute. Useful for capturing what CC actually sends.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8202;
const OUT = path.join(__dirname, 'sniffer.log');

function logBoth(s) {
    const line = `[${new Date().toISOString().substring(11,23)}] ${s}\n`;
    process.stdout.write(line);
    fs.appendFileSync(OUT, line);
}

http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        logBoth(`==== ${req.method} ${req.url}`);
        for (const [k, v] of Object.entries(req.headers)) {
            logBoth(`  H: ${k}: ${v}`);
        }
        const bodyPreview = body.toString('utf8').substring(0, 600);
        logBoth(`  BODY (${body.length}b): ${bodyPreview}`);

        // Forward to OmniRoute byte-for-byte (just fix Host + content-length)
        const headers = { ...req.headers };
        headers.host = `127.0.0.1:20128`;
        if (body.length) headers['content-length'] = body.length;

        const proxyReq = http.request({
            host: '127.0.0.1', port: 20128,
            method: req.method, path: req.url, headers,
        }, (proxyRes) => {
            logBoth(`  RESP: ${proxyRes.statusCode}`);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            logBoth(`  ERR: ${e.message}`);
            if (!res.headersSent) res.writeHead(502); res.end();
        });
        if (body.length) proxyReq.write(body);
        proxyReq.end();
    });
}).listen(PORT, '127.0.0.1', () => {
    logBoth(`sniffer on :${PORT} -> OmniRoute :20128 (logs to ${OUT})`);
});
