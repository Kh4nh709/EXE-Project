const prisma = require('../lib/prisma');
const { loadEventForWrite } = require('../lib/eventAccess');
const { attachmentHeader, inlineHeader } = require('../lib/contentDisposition');
const {
  DEFAULT_FIELDS, normalizeFields, certificateValues, generateCertificateCode,
} = require('../lib/certificateLayout');
const { renderCertificatePdf, inspectTemplateImage } = require('../services/certificatePdf');
const { certificateIdFromToken, certificateViewUrl } = require('../lib/certificateLink');
const emailService = require('../services/email.service');

const MIN_IMAGE_SIDE = 500;
const EMAIL_CONCURRENCY = 8;
const TEMPLATE_META = { mimeType: true, width: true, height: true, fields: true, updatedAt: true };

function serverError(res, label, err) {
  console.error(`${label} error:`, err);
  return res.status(500).json({ success: false, message: 'Lỗi server' });
}

// Ai đủ điều kiện mà CHƯA có chứng nhận: đã check-out và tài khoản còn hoạt động.
function pendingWhere(eventId) {
  return {
    eventId,
    status: 'CHECKED_OUT',
    user: { isActive: true, certificates: { none: { eventId } } },
  };
}

async function setupPayload(eventId) {
  const [template, issuedCount, pendingCount, emailFailed] = await Promise.all([
    prisma.eventCertificateTemplate.findUnique({ where: { eventId }, select: TEMPLATE_META }),
    prisma.certificate.count({ where: { eventId } }),
    prisma.attendance.count({ where: pendingWhere(eventId) }),
    prisma.certificate.count({ where: { eventId, emailStatus: 'FAILED' } }),
  ]);
  return { template, issuedCount, pendingCount, emailFailed };
}

// ───────────────────────────────────────────────────────────────
// BTC: mẫu chứng nhận của sự kiện (ADMIN hoặc người tạo sự kiện)
// ───────────────────────────────────────────────────────────────

async function getCertificateSetup(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    return res.json({ success: true, data: await setupPayload(event.id) });
  } catch (err) {
    return serverError(res, 'Get certificate setup', err);
  }
}

async function getTemplateImage(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const tpl = await prisma.eventCertificateTemplate.findUnique({
      where: { eventId: event.id },
      select: { image: true, mimeType: true },
    });
    if (!tpl) return res.status(404).json({ success: false, error: 'NO_TEMPLATE', message: 'Sự kiện chưa có mẫu chứng nhận' });
    res.set('Content-Type', tpl.mimeType);
    res.set('Cache-Control', 'private, no-cache');
    return res.send(Buffer.from(tpl.image));
  } catch (err) {
    return serverError(res, 'Get certificate image', err);
  }
}

// Upload/đổi ảnh mẫu. Đổi ảnh thì GIỮ bố cục đang có (thường chỉ sửa thiết kế nền).
async function uploadTemplateImage(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ success: false, message: 'Chưa chọn file ảnh' });
    }

    const info = await inspectTemplateImage(req.file.buffer);
    if (info.error) return res.status(400).json({ success: false, message: info.error });
    const { mimeType, width, height } = info.value;
    if (Math.min(width, height) < MIN_IMAGE_SIDE) {
      return res.status(400).json({
        success: false,
        message: `Ảnh quá nhỏ (${width}×${height}px) — cần tối thiểu ${MIN_IMAGE_SIDE}px mỗi chiều để in rõ`,
      });
    }

    await prisma.eventCertificateTemplate.upsert({
      where: { eventId: event.id },
      create: { eventId: event.id, image: req.file.buffer, mimeType, width, height, fields: DEFAULT_FIELDS, updatedById: req.user.id },
      update: { image: req.file.buffer, mimeType, width, height, updatedById: req.user.id },
    });
    return res.json({ success: true, data: await setupPayload(event.id), message: 'Đã lưu ảnh mẫu chứng nhận' });
  } catch (err) {
    return serverError(res, 'Upload certificate image', err);
  }
}

async function saveTemplateFields(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const exists = await prisma.eventCertificateTemplate.findUnique({ where: { eventId: event.id }, select: { id: true } });
    if (!exists) return res.status(404).json({ success: false, error: 'NO_TEMPLATE', message: 'Hãy upload ảnh mẫu trước' });

    const fields = normalizeFields(req.body?.fields);
    if (fields.error) return res.status(400).json({ success: false, message: fields.error });

    await prisma.eventCertificateTemplate.update({
      where: { eventId: event.id },
      data: { fields: fields.value, updatedById: req.user.id },
    });
    return res.json({ success: true, data: await setupPayload(event.id), message: 'Đã lưu bố cục chứng nhận' });
  } catch (err) {
    return serverError(res, 'Save certificate fields', err);
  }
}

// Đã cấp chứng nhận thì không gỡ được mẫu: PDF vẽ lại từ mẫu mỗi lần tải, gỡ
// mẫu là mọi chứng nhận đã cấp không mở được nữa.
async function deleteTemplate(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const issued = await prisma.certificate.count({ where: { eventId: event.id } });
    if (issued > 0) {
      return res.status(409).json({
        success: false,
        error: 'CERTIFICATES_ISSUED',
        message: `Đã cấp ${issued} chứng nhận theo mẫu này nên không thể gỡ. Bạn vẫn có thể đổi ảnh hoặc chỉnh bố cục.`,
      });
    }
    await prisma.eventCertificateTemplate.deleteMany({ where: { eventId: event.id } });
    return res.json({ success: true, message: 'Đã gỡ mẫu chứng nhận' });
  } catch (err) {
    return serverError(res, 'Delete certificate template', err);
  }
}

// Xem thử PDF với dữ liệu mẫu — để BTC kiểm tra bản in trước khi cấp thật.
async function previewPdf(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const template = await prisma.eventCertificateTemplate.findUnique({ where: { eventId: event.id } });
    if (!template) return res.status(404).json({ success: false, error: 'NO_TEMPLATE', message: 'Sự kiện chưa có mẫu chứng nhận' });

    const sampleName = typeof req.query.name === 'string' && req.query.name.trim()
      ? req.query.name.trim().slice(0, 100)
      : 'Nguyễn Văn A';
    const values = certificateValues({ recipientName: sampleName, code: 'CN-XXXX-XXXX', issuedAt: new Date() }, event);
    const pdf = await renderCertificatePdf(template, values, { title: `Xem thử chứng nhận - ${event.name}` });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', inlineHeader(`xem-thu-chung-nhan-${event.name}`, 'pdf'));
    res.set('Cache-Control', 'no-store');
    return res.send(Buffer.from(pdf));
  } catch (err) {
    return serverError(res, 'Preview certificate', err);
  }
}

// Gửi email báo có chứng nhận. Mỗi chứng nhận được "giành" (PENDING/FAILED →
// SENDING) trước khi gửi, nên BTC bấm cấp hai lần liền cũng không ai nhận 2 email.
async function sendCertificateEmails(event, certs) {

  const sendOne = async (cert) => {
    const claimed = await prisma.certificate.updateMany({
      where: { id: cert.id, emailStatus: { in: ['PENDING', 'FAILED'] } },
      data: { emailStatus: 'SENDING' },
    });
    if (claimed.count === 0) return;
    try {
      // Mỗi người một link riêng (lib/certificateLink.js) — không cần tài khoản để xem.
      await emailService.sendCertificateEmail(cert.user.email, cert.recipientName, event, {
        viewUrl: certificateViewUrl(cert.id),
      });
      await prisma.certificate.update({ where: { id: cert.id }, data: { emailStatus: 'SENT', emailSentAt: new Date() } });
    } catch (err) {
      console.error('Certificate email failed:', err.message);
      await prisma.certificate.update({ where: { id: cert.id }, data: { emailStatus: 'FAILED' } }).catch(() => {});
    }
  };

  for (let i = 0; i < certs.length; i += EMAIL_CONCURRENCY) {
    await Promise.allSettled(certs.slice(i, i + EMAIL_CONCURRENCY).map(sendOne));
  }
}

// "Cấp chứng nhận": cấp cho mọi người mới đủ điều kiện + gửi lại email lỗi lần
// trước. Trả 202 rồi gửi email nền — danh sách dài vượt timeout của frontend và
// api.js sẽ tự gửi lại request.
async function issueCertificates(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    if (!event.isActive) return res.status(400).json({ success: false, message: 'Sự kiện đã bị xoá' });

    const template = await prisma.eventCertificateTemplate.findUnique({ where: { eventId: event.id }, select: { id: true } });
    if (!template) {
      return res.status(400).json({ success: false, error: 'NO_TEMPLATE', message: 'Hãy upload mẫu chứng nhận trước khi cấp' });
    }

    const pending = await prisma.attendance.findMany({
      where: pendingWhere(event.id),
      select: { user: { select: { id: true, name: true } } },
    });
    if (pending.length) {
      // skipDuplicates: bấm 2 lần cùng lúc không tạo 2 chứng nhận cho 1 người
      // (unique eventId+userId). Hiếm hoi trùng mã thì người đó được cấp ở lần bấm sau.
      await prisma.certificate.createMany({
        data: pending.map(({ user }) => ({
          code: generateCertificateCode(),
          eventId: event.id,
          userId: user.id,
          recipientName: user.name,
          issuedById: req.user.id,
        })),
        skipDuplicates: true,
      });
    }

    const toEmail = await prisma.certificate.findMany({
      where: { eventId: event.id, emailStatus: { in: ['PENDING', 'FAILED'] } },
      select: { id: true, recipientName: true, user: { select: { email: true } } },
    });

    if (!pending.length && !toEmail.length) {
      return res.status(400).json({
        success: false,
        error: 'NOTHING_TO_ISSUE',
        message: 'Không có ai mới đủ điều kiện nhận chứng nhận (cần đã check-out).',
      });
    }

    res.status(202).json({
      success: true,
      data: { issued: pending.length, emailing: toEmail.length },
      message: pending.length
        ? `Đã cấp ${pending.length} chứng nhận, đang gửi email thông báo`
        : `Đang gửi lại ${toEmail.length} email thông báo`,
    });

    sendCertificateEmails(event, toEmail).catch((err) => console.error('Certificate email batch error:', err));
  } catch (err) {
    return serverError(res, 'Issue certificates', err);
  }
}

async function listEventCertificates(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const certs = await prisma.certificate.findMany({
      where: { eventId: event.id },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true, code: true, recipientName: true, issuedAt: true, emailStatus: true, emailSentAt: true,
        user: { select: { mssv: true, email: true } },
      },
    });
    return res.json({ success: true, data: certs });
  } catch (err) {
    return serverError(res, 'List event certificates', err);
  }
}

// Thu hồi (cấp nhầm). Người đó vẫn đủ điều kiện thì lần "Cấp chứng nhận" sau sẽ
// được cấp lại với mã mới.
async function revokeCertificate(req, res) {
  try {
    const event = await loadEventForWrite(req, res);
    if (!event) return;
    const { count } = await prisma.certificate.deleteMany({ where: { id: req.params.certId, eventId: event.id } });
    if (!count) return res.status(404).json({ success: false, message: 'Không tìm thấy chứng nhận' });
    return res.json({ success: true, message: 'Đã thu hồi chứng nhận' });
  } catch (err) {
    return serverError(res, 'Revoke certificate', err);
  }
}

// ───────────────────────────────────────────────────────────────
// Xem / tải một chứng nhận: người nhận qua link trong email (/api/public/certificates/:token),
// ADMIN hoặc người tạo sự kiện qua /api/certificates/:id.
// ───────────────────────────────────────────────────────────────

// Người khác nhận 404 (không phải 403) để không dò được id chứng nhận nào tồn tại.
async function loadCertificateForView(req, res) {
  const viaLink = req.params.token !== undefined;
  const id = viaLink ? certificateIdFromToken(req.params.token) : req.params.id;
  const cert = id
    ? await prisma.certificate.findUnique({
      where: { id },
      include: { event: { select: { id: true, name: true, checkinOpen: true, createdById: true, isActive: true } } },
    })
    : null;
  const allowed = cert && cert.event.isActive && (
    viaLink || req.user?.role === 'ADMIN' || cert.event.createdById === req.user?.id
  );
  if (!allowed) {
    res.status(404).json({ success: false, error: 'CERTIFICATE_NOT_FOUND', message: 'Không tìm thấy chứng nhận' });
    return null;
  }
  return cert;
}

async function getCertificate(req, res) {
  try {
    const cert = await loadCertificateForView(req, res);
    if (!cert) return;
    const template = await prisma.eventCertificateTemplate.findUnique({ where: { eventId: cert.eventId }, select: TEMPLATE_META });
    if (!template) return res.status(404).json({ success: false, error: 'NO_TEMPLATE', message: 'Mẫu chứng nhận không còn tồn tại' });

    return res.json({
      success: true,
      data: {
        id: cert.id,
        code: cert.code,
        issuedAt: cert.issuedAt,
        event: { id: cert.event.id, name: cert.event.name },
        values: certificateValues(cert, cert.event),
        template,
      },
    });
  } catch (err) {
    return serverError(res, 'Get certificate', err);
  }
}

async function getCertificateBackground(req, res) {
  try {
    const cert = await loadCertificateForView(req, res);
    if (!cert) return;
    const tpl = await prisma.eventCertificateTemplate.findUnique({
      where: { eventId: cert.eventId },
      select: { image: true, mimeType: true },
    });
    if (!tpl) return res.status(404).json({ success: false, error: 'NO_TEMPLATE', message: 'Mẫu chứng nhận không còn tồn tại' });
    res.set('Content-Type', tpl.mimeType);
    res.set('Cache-Control', 'private, no-cache');
    return res.send(Buffer.from(tpl.image));
  } catch (err) {
    return serverError(res, 'Get certificate background', err);
  }
}

async function downloadCertificatePdf(req, res) {
  try {
    const cert = await loadCertificateForView(req, res);
    if (!cert) return;
    const template = await prisma.eventCertificateTemplate.findUnique({ where: { eventId: cert.eventId } });
    if (!template) return res.status(404).json({ success: false, error: 'NO_TEMPLATE', message: 'Mẫu chứng nhận không còn tồn tại' });

    const pdf = await renderCertificatePdf(template, certificateValues(cert, cert.event), {
      title: `Chứng nhận - ${cert.recipientName} - ${cert.event.name}`,
    });
    const inline = req.query.view === '1';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', (inline ? inlineHeader : attachmentHeader)(`chung-nhan-${cert.event.name}-${cert.recipientName}`, 'pdf'));
    res.set('Cache-Control', 'private, no-store');
    return res.send(Buffer.from(pdf));
  } catch (err) {
    return serverError(res, 'Download certificate', err);
  }
}

module.exports = {
  getCertificateSetup, getTemplateImage, uploadTemplateImage, saveTemplateFields, deleteTemplate,
  previewPdf, issueCertificates, listEventCertificates, revokeCertificate,
  getCertificate, getCertificateBackground, downloadCertificatePdf,
  sendCertificateEmails,
};
