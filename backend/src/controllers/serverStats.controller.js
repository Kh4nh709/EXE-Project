// GET /api/admin/server-stats — giám sát server cho admin mà không cần SSH.
// Cố tình KHÔNG nhận tham số nào từ client và KHÔNG chạy lệnh system: một
// endpoint chạy lệnh tùy ý là lỗ hổng RCE (ai chiếm được token admin — hoặc
// lộ route — là chạy được mọi lệnh trên server Render). Chỉ trả các chỉ số
// đọc từ os/process + một probe DB rẻ tiền, đủ để biết máy sống hay chết.
const os = require('os');
const prisma = require('../lib/prisma');

function serverError(res, label, err) {
  console.error(`${label} error:`, err);
  return res.status(500).json({ success: false, error: 'SERVER_STATS_FAILED', message: 'Lỗi server' });
}

async function getServerStats(req, res) {
  try {
    // DB không trả lời vẫn là thông tin giám sát hữu ích → báo db.ok=false chứ
    // không Fail cả request.
    let db = { ok: false, latencyMs: null };
    try {
      const started = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      db = { ok: true, latencyMs: Date.now() - started };
    } catch (dbErr) {
      console.error('server-stats DB probe error:', dbErr);
    }

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
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return serverError(res, 'getServerStats', err);
  }
}

module.exports = { getServerStats };
