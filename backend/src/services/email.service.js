const https = require('https');
const { fmtDateTime } = require('../lib/datetime');

function brevoRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        'accept': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Brevo API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sender = {
  name: process.env.BREVO_SENDER_NAME || 'FPT Event System',
  email: process.env.BREVO_SENDER_EMAIL,
};

function assertConfigured() {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    throw new Error('Email chưa cấu hình: thiếu BREVO_API_KEY / BREVO_SENDER_EMAIL');
  }
}

async function sendOtpEmail(email, name, otp) {
  assertConfigured();
  await brevoRequest({
    sender,
    to: [{ email }],
    subject: '[FPT Event] Xác thực thiết bị mới',
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${name}</strong>,</p>
          <p style="color: #6b7b9a;">Mã OTP để xác thực thiết bị mới của bạn:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #1a6bff;">${otp}</span>
          </div>
          <p style="color: #6b7b9a; font-size: 14px;">Mã có hiệu lực trong <strong>10 phút</strong>. Không chia sẻ mã này với bất kỳ ai.</p>
        </div>
      </div>
    `,
  });
}

async function sendWelcomeEmail(email, name, mssv, tempPassword) {
  assertConfigured();
  await brevoRequest({
    sender,
    to: [{ email }],
    subject: '[FPT Event] Tài khoản của bạn đã được tạo',
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${name}</strong>,</p>
          <p style="color: #6b7b9a;">Tài khoản của bạn trên hệ thống FPT Event đã được tạo.</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 8px; color: #6b7b9a; font-size: 14px;">Thông tin đăng nhập:</p>
            <p style="margin: 0 0 4px;"><strong>MSSV:</strong> ${mssv}</p>
            <p style="margin: 0 0 4px;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 0;"><strong>Mật khẩu tạm:</strong> <span style="color: #1a6bff; font-family: monospace;">${tempPassword}</span></p>
          </div>
          <p style="color: #ff4d6a; font-size: 14px;">Vui lòng đổi mật khẩu sau lần đăng nhập đầu tiên.</p>
        </div>
      </div>
    `,
  });
}


async function sendPasswordResetEmail(email, name, newPassword) {
  assertConfigured();
  await brevoRequest({
    sender,
    to: [{ email }],
    subject: '[FPT Event] Mật khẩu của bạn đã được đặt lại',
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${name}</strong>,</p>
          <p style="color: #6b7b9a;">Quản trị viên vừa đặt lại mật khẩu cho tài khoản của bạn.</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 8px; color: #6b7b9a; font-size: 14px;">Mật khẩu mới:</p>
            <p style="margin: 0;"><span style="color: #1a6bff; font-family: monospace; font-size: 18px;">${newPassword}</span></p>
          </div>
          <p style="color: #ff4d6a; font-size: 14px;">Bạn sẽ được yêu cầu đổi mật khẩu ngay sau khi đăng nhập lần tới. Nếu bạn không yêu cầu đặt lại mật khẩu, hãy liên hệ quản trị viên.</p>
        </div>
      </div>
    `,
  });
}

// OTP đặt lại mật khẩu (người dùng tự bấm "Quên mật khẩu"). Khác
// sendPasswordResetEmail ở chỗ KHÔNG gửi mật khẩu thật qua email — chỉ gửi mã
// để người dùng tự đặt mật khẩu mới trên trình duyệt.
async function sendPasswordResetOtpEmail(email, name, otp) {
  assertConfigured();
  await brevoRequest({
    sender,
    to: [{ email }],
    subject: '[FPT Event] Mã đặt lại mật khẩu',
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${name}</strong>,</p>
          <p style="color: #6b7b9a;">Mã xác thực để đặt lại mật khẩu tài khoản của bạn:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #1a6bff;">${otp}</span>
          </div>
          <p style="color: #6b7b9a; font-size: 14px;">Mã có hiệu lực trong <strong>15 phút</strong>. Không chia sẻ mã này với bất kỳ ai.</p>
          <p style="color: #ff4d6a; font-size: 14px;">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này — mật khẩu hiện tại vẫn an toàn.</p>
        </div>
      </div>
    `,
  });
}

// Mã đăng nhập không cần mật khẩu (sinh viên quét QR rồi chọn "Đăng nhập bằng
// OTP"). Tách riêng khỏi sendOtpEmail vì ngữ cảnh khác hẳn: đây là đăng nhập,
// không phải xác thực thiết bị mới sau khi đã nhập đúng mật khẩu.
async function sendLoginOtpEmail(email, name, otp) {
  assertConfigured();
  await brevoRequest({
    sender,
    to: [{ email }],
    subject: '[FPT Event] Mã đăng nhập của bạn',
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${name}</strong>,</p>
          <p style="color: #6b7b9a;">Mã đăng nhập của bạn:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #1a6bff;">${otp}</span>
          </div>
          <p style="color: #6b7b9a; font-size: 14px;">Mã có hiệu lực trong <strong>10 phút</strong> và chỉ dùng được trên thiết bị vừa yêu cầu.</p>
          <p style="color: #ff4d6a; font-size: 14px;">Nếu bạn không yêu cầu đăng nhập, hãy bỏ qua email này và đổi mật khẩu.</p>
        </div>
      </div>
    `,
  });
}

// Xác nhận đăng ký tham gia sự kiện. Nếu tài khoản vừa được tạo từ form đăng ký
// thì kèm luôn mật khẩu tạm để người dùng đăng nhập quét QR điểm danh.
async function sendEventRegistrationEmail(email, name, event, { mssv, tempPassword } = {}) {
  assertConfigured();

  const fmt = (d) => fmtDateTime(d, { dateStyle: 'full', timeStyle: 'short' });

  const credentialsBlock = tempPassword
    ? `
          <div style="background: #fff8e6; border: 1px solid #ffe0a3; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 8px; color: #6b7b9a; font-size: 14px;">Tài khoản đăng nhập vừa được tạo cho bạn:</p>
            <p style="margin: 0 0 4px;"><strong>MSSV:</strong> ${mssv || '—'}</p>
            <p style="margin: 0 0 4px;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 0;"><strong>Mật khẩu tạm:</strong> <span style="color: #1a6bff; font-family: monospace;">${tempPassword}</span></p>
            <p style="margin: 12px 0 0; color: #ff4d6a; font-size: 13px;">Hãy đăng nhập và đổi mật khẩu trước khi sự kiện diễn ra.</p>
          </div>`
    : '';

  await brevoRequest({
    sender,
    to: [{ email }],
    subject: `[FPT Event] Đăng ký thành công: ${event.name}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${name}</strong>,</p>
          <p style="color: #6b7b9a;">Bạn đã đăng ký tham gia sự kiện thành công. Thông tin chi tiết:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 6px; font-size: 17px;"><strong>${event.name}</strong></p>
            <p style="margin: 0 0 4px; color: #6b7b9a;"><strong>Địa điểm:</strong> ${event.location}</p>
            <p style="margin: 0; color: #6b7b9a;"><strong>Thời gian:</strong> ${fmt(event.checkinOpen)}</p>
          </div>${credentialsBlock}
          <p style="color: #6b7b9a; font-size: 14px;">Đến ngày sự kiện, hãy đăng nhập hệ thống và quét mã QR tại cửa vào để điểm danh.</p>
        </div>
      </div>
    `,
  });
}

// Nội dung do BTC nhập (tên sự kiện, lời nhắn) được chèn vào HTML email.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Nhắc lịch sự kiện sắp diễn ra (BTC gửi tay). leadText: "sẽ diễn ra vào ngày
// mai", "sẽ bắt đầu sau 3 giờ nữa", "đang diễn ra"... do lib/eventReminder.js
// tính theo lúc gửi.
// Mã OTP check-in không cần đăng nhập (trang quét mã). Ghi rõ tên sự kiện: người
// nhận mã mà không đứng ở sự kiện đó biết ngay là có người đang check-in hộ mình.
async function sendCheckinOtpEmail(email, name, otp, event) {
  assertConfigured();
  await brevoRequest({
    sender,
    to: [{ email }],
    subject: `[FPT Event] Mã check-in: ${otp}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${escapeHtml(name)}</strong>,</p>
          <p style="color: #6b7b9a;">Mã xác minh để điểm danh sự kiện <strong style="color: #0d1b2e;">${escapeHtml(event.name)}</strong>:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #1a6bff;">${otp}</span>
          </div>
          <p style="color: #6b7b9a; font-size: 14px;">Mã có hiệu lực trong <strong>10 phút</strong> và chỉ dùng được trên điện thoại vừa quét mã QR.</p>
          <p style="color: #ff4d6a; font-size: 14px;">Nếu bạn không có mặt ở sự kiện này, đừng gửi mã cho ai — có người đang định điểm danh hộ bạn.</p>
        </div>
      </div>
    `,
  });
}

async function sendEventReminderEmail(email, name, event, { leadText, note, loginUrl } = {}) {
  assertConfigured();

  const when = event.checkinOpen
    ? fmtDateTime(event.checkinOpen, { dateStyle: 'full', timeStyle: 'short' })
    : null;
  const noteBlock = note
    ? `
          <div style="background: #fff8e6; border-left: 4px solid #ffb020; border-radius: 6px; padding: 14px 16px; margin: 0 0 24px;">
            <p style="margin: 0 0 4px; color: #6b7b9a; font-size: 13px;">Lời nhắn từ Ban tổ chức:</p>
            <p style="margin: 0; color: #0d1b2e; white-space: pre-line;">${escapeHtml(note)}</p>
          </div>`
    : '';
  const loginBlock = loginUrl
    ? `<p style="text-align: center; margin: 28px 0 8px;">
            <a href="${escapeHtml(loginUrl)}" style="background: #1A6BFF; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">Đăng nhập trước</a>
          </p>`
    : '';

  await brevoRequest({
    sender,
    to: [{ email }],
    subject: `[FPT Event] Nhắc lịch: ${event.name}${leadText ? ` (${leadText})` : ''}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${escapeHtml(name)}</strong>,</p>
          <p style="color: #6b7b9a;">Sự kiện bạn đã đăng ký <strong style="color: #1a6bff;">${escapeHtml(leadText || 'sắp diễn ra')}</strong>:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 6px; font-size: 17px;"><strong>${escapeHtml(event.name)}</strong></p>
            <p style="margin: 0 0 4px; color: #6b7b9a;"><strong>Địa điểm:</strong> ${escapeHtml(event.location)}</p>
            ${when ? `<p style="margin: 0; color: #6b7b9a;"><strong>Thời gian:</strong> ${escapeHtml(when)}</p>` : ''}
          </div>${noteBlock}
          <p style="color: #6b7b9a; font-size: 14px;">Hãy đăng nhập sẵn trên điện thoại để quét mã QR điểm danh nhanh hơn khi tới nơi.</p>
          ${loginBlock}
        </div>
      </div>
    `,
  });
}

// Báo chứng nhận tham gia đã sẵn sàng. Không đính kèm PDF: vài trăm email
// kèm file dễ bị Brevo/Gmail chặn, và chứng nhận luôn xem/tải lại được trên web.
async function sendCertificateEmail(email, name, event, { viewUrl } = {}) {
  assertConfigured();
  const button = viewUrl
    ? `<p style="text-align: center; margin: 28px 0 8px;">
            <a href="${escapeHtml(viewUrl)}" style="background: #1A6BFF; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">Xem và tải chứng nhận</a>
          </p>`
    : '';

  await brevoRequest({
    sender,
    to: [{ email }],
    subject: `[FPT Event] Chứng nhận tham gia: ${event.name}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">FPT Event System</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Xin chào <strong>${escapeHtml(name)}</strong>,</p>
          <p style="color: #6b7b9a;">Cảm ơn bạn đã tham gia sự kiện. Chứng nhận tham gia của bạn đã sẵn sàng:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0; font-size: 17px;"><strong>${escapeHtml(event.name)}</strong></p>
          </div>
          <p style="color: #6b7b9a; font-size: 14px;">Đăng nhập hệ thống, vào mục <strong>Chứng nhận của tôi</strong> để xem và tải file PDF.</p>
          ${button}
        </div>
      </div>
    `,
  });
}

// Brevo giới hạn tổng dung lượng file đính kèm; thiệp dùng ảnh nền nặng thì bỏ
// file, khách vẫn mở/tải thiệp qua link.
const MAX_INVITATION_ATTACHMENT = 3 * 1024 * 1024;

// Thiệp mời gửi khách ngoài (không có tài khoản). Khác chứng nhận, ở đây KHÔNG thể
// bảo người nhận "đăng nhập để tải" — nên kèm luôn PDF, cùng link trang xem thiệp
// (có QR to để đưa ra ở cửa, dùng được cả khi lạc mất file).
async function sendInvitationEmail(email, name, event, { whenText, seatText, viewUrl, pdf, filename } = {}) {
  assertConfigured();
  const button = viewUrl
    ? `<p style="text-align: center; margin: 28px 0 8px;">
            <a href="${escapeHtml(viewUrl)}" style="background: #1A6BFF; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: bold; display: inline-block;">Xem thiệp mời và mã QR</a>
          </p>`
    : '';
  const attach = pdf && pdf.length <= MAX_INVITATION_ATTACHMENT;

  await brevoRequest({
    sender,
    to: [{ email }],
    subject: `[Thư mời] ${event.name}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #1A6BFF, #00A3FF); padding: 32px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Thư mời tham dự</h1>
        </div>
        <div style="background: #fff; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2eaff;">
          <p style="color: #0d1b2e; font-size: 16px;">Kính gửi <strong>${escapeHtml(name)}</strong>,</p>
          <p style="color: #6b7b9a;">Ban tổ chức trân trọng kính mời Quý khách tới dự:</p>
          <div style="background: #f0f7ff; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 6px; font-size: 17px;"><strong>${escapeHtml(event.name)}</strong></p>
            ${whenText ? `<p style="margin: 0 0 4px; color: #6b7b9a;"><strong>Thời gian:</strong> ${escapeHtml(whenText)}</p>` : ''}
            <p style="margin: 0; color: #6b7b9a;"><strong>Địa điểm:</strong> ${escapeHtml(event.location)}</p>
            ${seatText ? `<p style="margin: 8px 0 0; color: #C2410C; font-weight: bold;">${escapeHtml(seatText)}</p>` : ''}
          </div>
          <p style="color: #6b7b9a; font-size: 14px;">
            ${attach ? 'Thiệp mời đính kèm email này. ' : ''}Khi tới nơi, vui lòng xuất trình <strong>mã QR trên thiệp</strong>
            (in ra hoặc mở trên điện thoại) để Ban tổ chức check-in cho Quý khách.
          </p>
          ${button}
        </div>
      </div>
    `,
    ...(attach && { attachment: [{ name: filename || 'thiep-moi.pdf', content: Buffer.from(pdf).toString('base64') }] }),
  });
}

module.exports = {
  sendInvitationEmail,
  sendCertificateEmail,
  sendEventReminderEmail,
  sendOtpEmail,
  sendLoginOtpEmail,
  sendCheckinOtpEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordResetOtpEmail,
  sendEventRegistrationEmail,
};
