const prisma = require('./prisma');
const emailService = require('../services/email.service');
const { TIME_ZONE } = require('./datetime');

// Nhắc lịch sự kiện qua email — BTC bấm "Gửi nhắc ngay", không có nhắc tự
// động (Render gói free ngủ khi không có request nên hẹn giờ trong tiến trình
// không tin được, và BTC đã chọn tự gửi tay).

// Chặn BTC bấm gửi liên tục — mỗi lần là một email tới mọi người và Brevo gói
// free chỉ có ~300 email/ngày cho cả hệ thống.
const MANUAL_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_NOTE = 500;
const SEND_CONCURRENCY = 8;

function vnDateKey(d) {
  // en-CA cho dạng YYYY-MM-DD, so sánh ngày theo lịch VN chứ không theo UTC.
  return new Date(d).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

// Cụm "sẽ ..." chèn vào tiêu đề và nội dung email, tính theo lúc gửi.
function leadText(checkinOpen, now) {
  if (!checkinOpen) return null;
  const start = new Date(checkinOpen);
  const mins = Math.round((start - now) / 60_000);
  if (mins <= 0) return 'đang diễn ra';
  if (mins < 60) return `sẽ bắt đầu sau ${mins} phút nữa`;
  if (mins < 20 * 60) return `sẽ bắt đầu sau ${Math.round(mins / 60)} giờ nữa`;

  const days = Math.round((Date.parse(vnDateKey(start)) - Date.parse(vnDateKey(now))) / 86_400_000);
  if (days <= 1) return 'sẽ diễn ra vào ngày mai';
  return `sẽ diễn ra sau ${days} ngày nữa`;
}

// Người đã đăng ký = EventMember (mọi đường ghi danh đều qua addUsersToEvent).
// Bỏ người đã check-in — nhắc giữa sự kiện chỉ nhắm người chưa tới.
function recipientWhere(eventId) {
  return {
    eventId,
    user: {
      isActive: true,
      attendances: { none: { eventId, checkinTime: { not: null } } },
    },
  };
}

async function loadRecipients(eventId) {
  const members = await prisma.eventMember.findMany({
    where: recipientWhere(eventId),
    select: { user: { select: { id: true, email: true, name: true } } },
  });
  return members.map((m) => m.user).filter((u) => u?.email);
}

function countRecipients(eventId) {
  return prisma.eventMember.count({ where: recipientWhere(eventId) });
}

async function deliver(event, recipients, { now, note }) {
  const lead = leadText(event.checkinOpen, now);
  let sent = 0;
  let failed = 0;
  // Mỗi người một email riêng (không để cả danh sách trong "To"), chạy song
  // song có giới hạn để không bị Brevo chặn vì dồn request.
  for (let i = 0; i < recipients.length; i += SEND_CONCURRENCY) {
    const batch = recipients.slice(i, i + SEND_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((u) =>
      emailService.sendEventReminderEmail(u.email, u.name, event, { leadText: lead, note })));
    for (const r of results) {
      if (r.status === 'fulfilled') sent += 1;
      else {
        failed += 1;
        console.error('Reminder email failed:', r.reason?.message);
      }
    }
  }
  return { sent, failed };
}

// Gửi cho danh sách đã nạp và ghi kết quả vào dòng nhật ký đã tạo trước.
// Không bao giờ ném lỗi — được gọi nền sau khi đã trả response.
async function runDelivery(reminderId, event, recipients, { now = new Date(), note } = {}) {
  try {
    const { sent, failed } = await deliver(event, recipients, { now, note });
    const status = recipients.length > 0 && sent === 0 ? 'FAILED' : 'SENT';
    await prisma.eventReminder.update({
      where: { id: reminderId },
      data: { status, recipientCount: recipients.length, failedCount: failed, completedAt: new Date() },
    });
    return { status, recipientCount: recipients.length, sent, failed };
  } catch (err) {
    console.error('Reminder delivery error:', err);
    await prisma.eventReminder.update({
      where: { id: reminderId },
      data: { status: 'FAILED', recipientCount: recipients.length, completedAt: new Date() },
    }).catch(() => {});
    return { status: 'FAILED', recipientCount: recipients.length, sent: 0, failed: recipients.length };
  }
}

module.exports = {
  MANUAL_COOLDOWN_MS,
  MAX_NOTE,
  leadText,
  loadRecipients,
  countRecipients,
  runDelivery,
};
