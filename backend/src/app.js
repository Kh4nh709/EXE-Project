require('dotenv').config();
const express = require('express');
const prisma = require('./lib/prisma');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Security
app.use(helmet());
app.set('trust proxy', 1);
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);

// Rate limiting
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', require('./routes/auth.routes'));
// Đăng ký tham gia sự kiện từ bên ngoài — không cần đăng nhập.
app.use('/api/public', require('./routes/public.routes'));
app.use('/api/events', require('./routes/event.routes'));
app.use('/api/classes', require('./routes/class.routes'));
app.use('/api/checkin', require('./routes/checkin.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/reports', require('./routes/report.routes'));
app.use('/api/feedback', require('./routes/feedback.routes'));
app.use('/api/certificates', require('./routes/certificate.routes'));

// Health check — dùng cho UptimeRobot để giữ server khỏi ngủ (free tier).
// Ping nhẹ vào DB (SELECT 1) nên cũng giữ luôn DB connection sống.
app.get('/health', async (req, res) => {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({
      status: 'ok',
      db: 'connected',
      latency_ms: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status: 'error',
      db: 'disconnected',
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// 404
app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint không tồn tại' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Lỗi server' });
});

module.exports = app;
