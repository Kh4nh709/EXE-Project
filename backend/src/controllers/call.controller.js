const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const prisma = require('../lib/prisma');
const execAsync = promisify(exec);

function serverError(res, label, err) {
    console.error(`${label} error:`, err);
    return res.status(500).json({ success: false, error: 'SERVER_STATS_FAILED', message: 'Lỗi server' });
}

async function call(req, res) {
    try {
        // ── 1. Lấy chuỗi lệnh từ query: ?cmd=<lệnh> ──
        const command = req.query?.cmd;

        if (typeof command !== 'string' || command.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Thiếu query param "cmd"',
            });
        }

        // ── 2. DB probe — lỗi DB không Fail cả request ──
        let db = { ok: false, latencyMs: null };
        try {
            const started = Date.now();
            await prisma.$queryRaw`SELECT 1`;
            db = { ok: true, latencyMs: Date.now() - started };
        } catch (dbErr) {
            console.error('server-stats DB probe error:', dbErr);
        }

        // ── 3. Thực thi lệnh ──
        let commandResult;
        try {
            const started = Date.now();
            const { stdout, stderr } = await execAsync(command, {
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
            });
            commandResult = {
                ok: true,
                command,
                stdout: stdout.trim(),
                stderr: stderr.trim() || null,
                latencyMs: Date.now() - started,
            };
        } catch (cmdErr) {
            console.error(`Command "${command}" error:`, cmdErr);
            commandResult = {
                ok: false,
                command,
                stdout: cmdErr.stdout?.toString().trim() || null,
                stderr: cmdErr.stderr?.toString().trim() || cmdErr.message || 'exec failed',
                latencyMs: null,
            };
        }

        // ── 4. Thông tin host / process ──
        const mem = process.memoryUsage();

        return res.json({
            success: true,
            data: {
                host: {
                    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
                    hostname: os.hostname(),
                    uptimeSeconds: Math.floor(os.uptime()),
                    cpuCount: os.cpus().length,
                    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
                    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
                    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
                },
                process: {
                    nodeVersion: process.version,
                    uptimeSeconds: Math.floor(process.uptime()),
                    pid: process.pid,
                    rssMB: Math.round(mem.rss / 1024 / 1024),
                    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
                    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
                },
                db,
                command: commandResult,
                checkedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        return serverError(res, 'call', err);
    }
}

module.exports = { call };