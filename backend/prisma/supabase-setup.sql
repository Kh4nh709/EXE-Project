-- ============================================================
-- Attendance Management System - Supabase SQL Setup
-- Chạy toàn bộ file này trong Supabase SQL Editor
-- Project: https://supabase.com/dashboard
-- ============================================================

-- ============================================================
-- BƯỚC 1: Enable extensions cần thiết
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- BƯỚC 2: Tạo ENUM types
-- ============================================================
DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('ADMIN', 'BTC', 'LECTURER', 'STUDENT');
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AttendanceStatus" AS ENUM ('REGISTERED', 'CHECKED_IN', 'CHECKED_OUT', 'ABSENT');
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- AUTO = theo khung giờ đã đặt (chưa đặt đủ giờ thì coi là ĐÓNG cho tới khi
-- BTC bấm mở tay); OPEN/CLOSED = BTC chủ động mở/đóng, bỏ qua khung giờ.
DO $$ BEGIN
  CREATE TYPE "GateState" AS ENUM ('AUTO', 'OPEN', 'CLOSED');
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- STANDARD = QR màn chiếu, người tham dự tự quét; INVITATION = khách ngoài nhận
-- thiệp mời có QR riêng, BTC/tình nguyện viên quét thiệp. Chọn lúc tạo, không đổi.
DO $$ BEGIN
  CREATE TYPE "EventKind" AS ENUM ('STANDARD', 'INVITATION');
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- PUBLIC = check-in công khai: QR cố định, người ghé thăm tự điền form. DB đã có
-- EventKind từ trước thì phải thêm giá trị (PG 12+ chạy được trong transaction).
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'PUBLIC';

-- ============================================================
-- BƯỚC 3: Tạo các bảng
-- ============================================================

-- Bảng người dùng
CREATE TABLE IF NOT EXISTS "attendance_users" (
  "id"           TEXT        NOT NULL,
  "mssv"         TEXT,
  "email"        TEXT        NOT NULL,
  "name"         TEXT        NOT NULL,
  "role"         "Role"      NOT NULL DEFAULT 'STUDENT',
  "passwordHash" TEXT        NOT NULL,
  "class"        TEXT,
  "faculty"      TEXT,
  "phone"        TEXT,
  "isFirstLogin" BOOLEAN     NOT NULL DEFAULT TRUE,
  "isActive"     BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_users_pkey" PRIMARY KEY ("id")
);

-- Bảng lớp học (đơn vị chính thức, tách khỏi cột "class" dạng chuỗi tự do
-- trên attendance_users). Tạo trước attendance_events vì event tham chiếu tới đây.
CREATE TABLE IF NOT EXISTS "attendance_classes" (
  "id"          TEXT        NOT NULL,
  "name"        TEXT        NOT NULL,
  "description" TEXT,
  "isActive"    BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdById" TEXT        NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_classes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_classes_createdById_fkey"
    FOREIGN KEY ("createdById")
    REFERENCES "attendance_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Bắt CẢ HAI lỗi trùng ở mọi khối ADD CONSTRAINT: UNIQUE tạo kèm một index cùng tên,
-- nên khi DB đã có index đó (vd. do `prisma db push` tạo) Postgres báo duplicate_table
-- (42P07) chứ không phải duplicate_object — chỉ bắt một loại thì chạy lại file sẽ lỗi.
DO $$ BEGIN
  ALTER TABLE "attendance_classes"
    ADD CONSTRAINT "attendance_classes_name_key" UNIQUE ("name");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- Bảng sự kiện
CREATE TABLE IF NOT EXISTS "attendance_events" (
  "id"            TEXT             NOT NULL,
  "name"          TEXT             NOT NULL,
  "description"   TEXT,
  "location"      TEXT             NOT NULL,
  "lat"           DOUBLE PRECISION,
  "lng"           DOUBLE PRECISION,
  "radius"        DOUBLE PRECISION NOT NULL DEFAULT 100,
  "gpsEnabled"    BOOLEAN          NOT NULL DEFAULT TRUE,
  -- Khung giờ là TUỲ CHỌN — BTC có thể bỏ trống và chủ động mở/đóng điểm danh
  -- bằng checkinState/checkoutState thay vì đặt lịch trước.
  "checkinOpen"   TIMESTAMPTZ,
  "checkinClose"  TIMESTAMPTZ,
  "checkoutOpen"  TIMESTAMPTZ,
  "checkoutClose" TIMESTAMPTZ,
  "checkinState"  "GateState"      NOT NULL DEFAULT 'AUTO',
  "checkoutState" "GateState"      NOT NULL DEFAULT 'AUTO',
  "bannerUrl"     TEXT,
  "isWhitelisted" BOOLEAN          NOT NULL DEFAULT FALSE,
  "allowRegistration" BOOLEAN      NOT NULL DEFAULT TRUE,
  "isActive"      BOOLEAN          NOT NULL DEFAULT TRUE,
  -- Link chia sẻ báo cáo công khai (NULL = chưa chia sẻ / đã thu hồi).
  "reportShareToken" TEXT,
  "reportSharedAt"   TIMESTAMPTZ,
  "createdById"   TEXT             NOT NULL,
  -- Gắn với attendance_classes khi sự kiện này là một buổi điểm danh của lớp
  -- (tạo qua /api/classes/:id/sessions) — NULL với sự kiện thường.
  "classId"       TEXT,
  "createdAt"     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_events_createdById_fkey"
    FOREIGN KEY ("createdById")
    REFERENCES "attendance_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "attendance_events_classId_fkey"
    FOREIGN KEY ("classId")
    REFERENCES "attendance_classes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- CREATE TABLE IF NOT EXISTS ở trên bỏ qua bảng đã tồn tại, nên DB đang chạy cần
-- ALTER để có cột mới. Idempotent: chạy lại file này nhiều lần vẫn an toàn.
ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "allowRegistration" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "classId" TEXT;

-- Chia sẻ báo cáo qua link công khai. UNIQUE vì token là khoá tra cứu sự kiện
-- ở /api/public/reports/:token.
ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "reportShareToken" TEXT;

ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "reportSharedAt" TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE "attendance_events"
    ADD CONSTRAINT "attendance_events_reportShareToken_key" UNIQUE ("reportShareToken");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "attendance_events"
    ADD CONSTRAINT "attendance_events_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES "attendance_classes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- Nút "Mở điểm danh" / "Đóng điểm danh": khung giờ hết bắt buộc + cờ mở/đóng
-- thủ công. DB cũ có 4 cột giờ NOT NULL nên phải nới ràng buộc, không chỉ thêm cột.
ALTER TABLE "attendance_events"
  ALTER COLUMN "checkinOpen" DROP NOT NULL,
  ALTER COLUMN "checkinClose" DROP NOT NULL,
  ALTER COLUMN "checkoutOpen" DROP NOT NULL,
  ALTER COLUMN "checkoutClose" DROP NOT NULL;

ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "checkinState" "GateState" NOT NULL DEFAULT 'AUTO';

ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "checkoutState" "GateState" NOT NULL DEFAULT 'AUTO';

-- Sự kiện thiệp mời: kiểu sự kiện, giờ bắt đầu in trên thiệp, link quét cho tình
-- nguyện viên (cột thay vì HMAC vì phải thu hồi được — giống reportShareToken).
ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "kind" "EventKind" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS "startsAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "scannerToken" TEXT,
  ADD COLUMN IF NOT EXISTS "scannerSharedAt" TIMESTAMPTZ;

-- Check-in công khai: form BTC dựng ({ fields, thankYou }).
ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "publicForm" JSONB;

-- Sơ đồ ghế của sự kiện thiệp mời ({ rows, aisleAfter, disabled } — lib/seatMap.js).
ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "seatMap" JSONB;

-- Check-in bằng email + OTP không cần đăng nhập (mặc định bật).
ALTER TABLE "attendance_events"
  ADD COLUMN IF NOT EXISTS "otpCheckinEnabled" BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_events_scannerToken_key"
  ON "attendance_events"("scannerToken");

-- Bảng whitelist thành viên sự kiện
CREATE TABLE IF NOT EXISTS "attendance_event_members" (
  "id"      TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId"  TEXT NOT NULL,
  CONSTRAINT "attendance_event_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_event_members_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_event_members_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_event_members_eventId_userId_key"
    UNIQUE ("eventId", "userId")
);

-- Bảng điểm danh
CREATE TABLE IF NOT EXISTS "attendance_records" (
  "id"           TEXT               NOT NULL,
  "userId"       TEXT               NOT NULL,
  "eventId"      TEXT               NOT NULL,
  "checkinTime"  TIMESTAMPTZ,
  "checkoutTime" TIMESTAMPTZ,
  "checkinGps"   JSONB,
  "checkoutGps"  JSONB,
  "deviceId"     TEXT,
  "ip"           TEXT,
  "status"       "AttendanceStatus" NOT NULL DEFAULT 'REGISTERED',
  "createdAt"    TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_records_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "attendance_records_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "attendance_records_userId_eventId_key"
    UNIQUE ("userId", "eventId")
);

-- Bảng ghi nhận gian lận
CREATE TABLE IF NOT EXISTS "attendance_fraud_logs" (
  "id"        TEXT        NOT NULL,
  "userId"    TEXT,
  "eventId"   TEXT,
  "reason"    TEXT        NOT NULL,
  "ip"        TEXT,
  "deviceId"  TEXT,
  "gps"       JSONB,
  "token"     TEXT,
  "metadata"  JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_fraud_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_fraud_logs_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "attendance_fraud_logs_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Bảng binding thiết bị
CREATE TABLE IF NOT EXISTS "attendance_device_bindings" (
  "id"         TEXT        NOT NULL,
  "userId"     TEXT        NOT NULL,
  "deviceId"   TEXT        NOT NULL,
  "deviceInfo" TEXT,
  "isTrusted"  BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_device_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_device_bindings_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "attendance_device_bindings_userId_deviceId_key"
    UNIQUE ("userId", "deviceId")
);

-- Bảng OTP tokens
CREATE TABLE IF NOT EXISTS "attendance_otp_tokens" (
  "id"        TEXT        NOT NULL,
  "userId"    TEXT        NOT NULL,
  "token"     TEXT        NOT NULL,
  "deviceId"  TEXT        NOT NULL,
  "purpose"   TEXT        NOT NULL DEFAULT 'DEVICE_BIND',
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "used"      BOOLEAN     NOT NULL DEFAULT FALSE,
  "attempts"  INTEGER     NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_otp_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_otp_tokens_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Đếm lần nhập sai của mã OTP check-in (huỷ mã sau 5 lần sai).
ALTER TABLE "attendance_otp_tokens"
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;

-- ----- Đánh giá sau sự kiện -----
-- questions/answers là JSON, cấu trúc kiểm tra ở backend (lib/feedbackForm.js).

-- Thư viện mẫu form đánh giá (ADMIN + BTC dùng chung)
CREATE TABLE IF NOT EXISTS "attendance_feedback_templates" (
  "id"          TEXT        NOT NULL,
  "name"        TEXT        NOT NULL,
  "description" TEXT,
  "questions"   JSONB       NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_feedback_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_feedback_templates_createdById_fkey"
    FOREIGN KEY ("createdById")
    REFERENCES "attendance_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Form đánh giá của một sự kiện (bản sao câu hỏi lấy từ mẫu lúc gắn)
CREATE TABLE IF NOT EXISTS "attendance_feedback_forms" (
  "id"          TEXT        NOT NULL,
  "eventId"     TEXT        NOT NULL,
  "templateId"  TEXT,
  "title"       TEXT        NOT NULL,
  "description" TEXT,
  "questions"   JSONB       NOT NULL,
  "isAnonymous" BOOLEAN     NOT NULL DEFAULT FALSE,
  "isOpen"      BOOLEAN     NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_feedback_forms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_feedback_forms_eventId_key" UNIQUE ("eventId"),
  CONSTRAINT "attendance_feedback_forms_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_feedback_forms_templateId_fkey"
    FOREIGN KEY ("templateId")
    REFERENCES "attendance_feedback_templates"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Phiếu trả lời — mỗi người một phiếu cho mỗi form
CREATE TABLE IF NOT EXISTS "attendance_feedback_responses" (
  "id"        TEXT        NOT NULL,
  "formId"    TEXT        NOT NULL,
  "userId"    TEXT,
  "answers"   JSONB       NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_feedback_responses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_feedback_responses_formId_fkey"
    FOREIGN KEY ("formId")
    REFERENCES "attendance_feedback_forms"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_feedback_responses_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "attendance_feedback_responses_formId_userId_key"
    UNIQUE ("formId", "userId")
);

-- Nhật ký gửi nhắc lịch thủ công (nút "Gửi nhắc ngay" của BTC)
CREATE TABLE IF NOT EXISTS "attendance_event_reminders" (
  "id"             TEXT        NOT NULL,
  "eventId"        TEXT        NOT NULL,
  "status"         TEXT        NOT NULL DEFAULT 'SENDING',
  "recipientCount" INTEGER     NOT NULL DEFAULT 0,
  "failedCount"    INTEGER     NOT NULL DEFAULT 0,
  "note"           TEXT,
  "triggeredById"  TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt"    TIMESTAMPTZ,
  CONSTRAINT "attendance_event_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_event_reminders_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_event_reminders_triggeredById_fkey"
    FOREIGN KEY ("triggeredById")
    REFERENCES "attendance_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Mẫu chứng nhận của sự kiện (ảnh nền lưu trong DB + vị trí các ô thông tin)
CREATE TABLE IF NOT EXISTS "attendance_certificate_templates" (
  "id"          TEXT        NOT NULL,
  "eventId"     TEXT        NOT NULL,
  "image"       BYTEA       NOT NULL,
  "mimeType"    TEXT        NOT NULL,
  "width"       INTEGER     NOT NULL,
  "height"      INTEGER     NOT NULL,
  "fields"      JSONB       NOT NULL,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_certificate_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_certificate_templates_eventId_key" UNIQUE ("eventId"),
  CONSTRAINT "attendance_certificate_templates_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Chứng nhận đã cấp (PDF vẽ lại từ mẫu mỗi lần tải, không lưu file)
CREATE TABLE IF NOT EXISTS "attendance_certificates" (
  "id"            TEXT        NOT NULL,
  "code"          TEXT        NOT NULL,
  "eventId"       TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL,
  "recipientName" TEXT        NOT NULL,
  "issuedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "issuedById"    TEXT,
  "emailStatus"   TEXT        NOT NULL DEFAULT 'PENDING',
  "emailSentAt"   TIMESTAMPTZ,
  CONSTRAINT "attendance_certificates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_certificates_code_key" UNIQUE ("code"),
  CONSTRAINT "attendance_certificates_eventId_userId_key" UNIQUE ("eventId", "userId"),
  CONSTRAINT "attendance_certificates_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_certificates_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_certificates_issuedById_fkey"
    FOREIGN KEY ("issuedById")
    REFERENCES "attendance_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Khách mời của sự kiện thiệp mời — không gắn với tài khoản. "code" là bí mật in
-- trong QR; email trùng trong cùng sự kiện bị chặn (NULL thì không tính trùng).
CREATE TABLE IF NOT EXISTS "attendance_event_guests" (
  "id"           TEXT        NOT NULL,
  "eventId"      TEXT        NOT NULL,
  "name"         TEXT        NOT NULL,
  "phone"        TEXT,
  "email"        TEXT,
  "code"         TEXT        NOT NULL,
  "isWalkIn"     BOOLEAN     NOT NULL DEFAULT FALSE,
  "inviteStatus" TEXT        NOT NULL DEFAULT 'PENDING',
  "inviteSentAt" TIMESTAMPTZ,
  "checkedInAt"  TIMESTAMPTZ,
  "checkedInBy"  TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_event_guests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_event_guests_code_key" UNIQUE ("code"),
  CONSTRAINT "attendance_event_guests_eventId_email_key" UNIQUE ("eventId", "email"),
  CONSTRAINT "attendance_event_guests_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Câu trả lời form check-in công khai của từng người.
ALTER TABLE "attendance_event_guests"
  ADD COLUMN IF NOT EXISTS "answers" JSONB;

-- Một thiệp/mã QR có thể mang nhiều vé (người đặt hộ người thân).
ALTER TABLE "attendance_event_guests"
  ADD COLUMN IF NOT EXISTS "ticketCount" INTEGER NOT NULL DEFAULT 1;

-- Khoá chống trùng của check-in công khai ("fieldId:giá trị chuẩn hoá"), unique theo
-- sự kiện để hai người gửi cùng SĐT cùng lúc bị chặn ngay ở DB.
CREATE TABLE IF NOT EXISTS "attendance_event_guest_keys" (
  "id"      TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guestId" TEXT NOT NULL,
  "key"     TEXT NOT NULL,
  CONSTRAINT "attendance_event_guest_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_event_guest_keys_eventId_key_key" UNIQUE ("eventId", "key"),
  CONSTRAINT "attendance_event_guest_keys_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_event_guest_keys_guestId_fkey"
    FOREIGN KEY ("guestId")
    REFERENCES "attendance_event_guests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Ghế đã gán cho khách mời, unique theo sự kiện để không ai bị gán trùng ghế.
CREATE TABLE IF NOT EXISTS "attendance_event_guest_seats" (
  "id"      TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guestId" TEXT NOT NULL,
  "seat"    TEXT NOT NULL,
  CONSTRAINT "attendance_event_guest_seats_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_event_guest_seats_eventId_seat_key" UNIQUE ("eventId", "seat"),
  CONSTRAINT "attendance_event_guest_seats_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attendance_event_guest_seats_guestId_fkey"
    FOREIGN KEY ("guestId")
    REFERENCES "attendance_event_guests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Mẫu thiệp mời (cùng cách lưu với mẫu chứng nhận)
CREATE TABLE IF NOT EXISTS "attendance_invitation_templates" (
  "id"          TEXT        NOT NULL,
  "eventId"     TEXT        NOT NULL,
  "image"       BYTEA       NOT NULL,
  "mimeType"    TEXT        NOT NULL,
  "width"       INTEGER     NOT NULL,
  "height"      INTEGER     NOT NULL,
  "fields"      JSONB       NOT NULL,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "attendance_invitation_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_invitation_templates_eventId_key" UNIQUE ("eventId"),
  CONSTRAINT "attendance_invitation_templates_eventId_fkey"
    FOREIGN KEY ("eventId")
    REFERENCES "attendance_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Khuôn mặt cho check-in tại cửa: chỉ vector (do trình duyệt tính) + thumbnail nhỏ,
-- không lưu ảnh gốc. Xoá user thì xoá luôn dữ liệu sinh trắc học.
CREATE TABLE IF NOT EXISTS "attendance_face_profiles" (
  "id"              TEXT        NOT NULL,
  "userId"          TEXT        NOT NULL,
  "embedding"       BYTEA       NOT NULL,
  "model"           TEXT        NOT NULL,
  "thumbnail"       BYTEA,
  "source"          TEXT        NOT NULL,
  "importEmbedding" BYTEA,
  -- TIMESTAMP(3), không TIMESTAMPTZ: đúng kiểu Prisma sinh cho DateTime. Lệch kiểu thì
  -- `prisma db push` khi build trên Render đòi ALTER bảng này.
  "consentAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attendance_face_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_face_profiles_userId_key" UNIQUE ("userId"),
  CONSTRAINT "attendance_face_profiles_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "attendance_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Bật RLS cho các bảng mới: KHÔNG tạo policy nào, nên anon/authenticated key
-- (REST API của Supabase — project này dùng chung với ứng dụng khác) không đọc
-- ghi được gì. Backend kết nối bằng role postgres (chủ bảng, có BYPASSRLS) nên
-- không bị ảnh hưởng. ENABLE nhiều lần không lỗi.
ALTER TABLE "attendance_feedback_templates"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_feedback_forms"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_feedback_responses"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_event_reminders"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_certificate_templates"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_certificates"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_event_guests"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_invitation_templates"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_event_guest_keys"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_event_guest_seats"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_face_profiles"          ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- BƯỚC 4: UNIQUE constraints bổ sung
-- ============================================================

-- attendance_users: email unique
DO $$ BEGIN
  ALTER TABLE "attendance_users"
    ADD CONSTRAINT "attendance_users_email_key" UNIQUE ("email");
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- attendance_users: mssv unique (chỉ khi không NULL)
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_users_mssv_key"
  ON "attendance_users"("mssv")
  WHERE "mssv" IS NOT NULL;

-- ============================================================
-- BƯỚC 5: INDEXES - Tối ưu hiệu năng truy vấn
-- ============================================================

-- ----- attendance_users -----
-- Lọc theo vai trò (admin list users by role)
CREATE INDEX IF NOT EXISTS "idx_users_role"
  ON "attendance_users"("role");

-- Lọc tài khoản active
CREATE INDEX IF NOT EXISTS "idx_users_isActive"
  ON "attendance_users"("isActive");

-- Tìm active users theo role (query phổ biến nhất)
CREATE INDEX IF NOT EXISTS "idx_users_role_isActive"
  ON "attendance_users"("role", "isActive");

-- ----- attendance_events -----
-- FK lookup khi join với users
CREATE INDEX IF NOT EXISTS "idx_events_createdById"
  ON "attendance_events"("createdById");

-- Lọc sự kiện đang hoạt động
CREATE INDEX IF NOT EXISTS "idx_events_isActive"
  ON "attendance_events"("isActive");

-- Lọc sự kiện whitelist
CREATE INDEX IF NOT EXISTS "idx_events_isWhitelisted"
  ON "attendance_events"("isWhitelisted");

-- Sort/filter theo thời gian check-in mở
CREATE INDEX IF NOT EXISTS "idx_events_checkinOpen"
  ON "attendance_events"("checkinOpen");

-- Query trang student dashboard: active + sắp xếp thời gian
CREATE INDEX IF NOT EXISTS "idx_events_isActive_checkinOpen"
  ON "attendance_events"("isActive", "checkinOpen" DESC);

-- Query BTC event list: active + whitelist filter
CREATE INDEX IF NOT EXISTS "idx_events_isActive_isWhitelisted"
  ON "attendance_events"("isActive", "isWhitelisted");

-- Query danh sách sự kiện công khai đang mở đăng ký (/api/public/events)
CREATE INDEX IF NOT EXISTS "idx_events_isActive_allowRegistration_checkinClose"
  ON "attendance_events"("isActive", "allowRegistration", "checkinClose");

-- FK lookup + liệt kê buổi điểm danh theo lớp (/api/classes/:id/sessions)
CREATE INDEX IF NOT EXISTS "idx_events_classId"
  ON "attendance_events"("classId");

-- ----- attendance_classes -----
CREATE INDEX IF NOT EXISTS "idx_classes_isActive"
  ON "attendance_classes"("isActive");

-- ----- attendance_event_members -----
-- FK lookup eventId (kiểm tra whitelist theo event)
CREATE INDEX IF NOT EXISTS "idx_event_members_eventId"
  ON "attendance_event_members"("eventId");

-- FK lookup userId (danh sách event của user)
CREATE INDEX IF NOT EXISTS "idx_event_members_userId"
  ON "attendance_event_members"("userId");

-- ----- attendance_records -----
-- FK lookup userId (lịch sử điểm danh của sinh viên)
CREATE INDEX IF NOT EXISTS "idx_records_userId"
  ON "attendance_records"("userId");

-- FK lookup eventId (danh sách điểm danh của sự kiện)
CREATE INDEX IF NOT EXISTS "idx_records_eventId"
  ON "attendance_records"("eventId");

-- Lọc theo trạng thái điểm danh
CREATE INDEX IF NOT EXISTS "idx_records_status"
  ON "attendance_records"("status");

-- Sort lịch sử theo thời gian check-in
CREATE INDEX IF NOT EXISTS "idx_records_checkinTime"
  ON "attendance_records"("checkinTime" DESC);

-- Query báo cáo: event + status (thống kê theo event)
CREATE INDEX IF NOT EXISTS "idx_records_eventId_status"
  ON "attendance_records"("eventId", "status");

-- Query student: userId + status (lịch sử filtered)
CREATE INDEX IF NOT EXISTS "idx_records_userId_status"
  ON "attendance_records"("userId", "status");

-- ----- attendance_fraud_logs -----
-- FK lookup userId
CREATE INDEX IF NOT EXISTS "idx_fraud_logs_userId"
  ON "attendance_fraud_logs"("userId");

-- FK lookup eventId
CREATE INDEX IF NOT EXISTS "idx_fraud_logs_eventId"
  ON "attendance_fraud_logs"("eventId");

-- Sort theo thời gian (gần nhất lên đầu)
CREATE INDEX IF NOT EXISTS "idx_fraud_logs_createdAt"
  ON "attendance_fraud_logs"("createdAt" DESC);

-- Query filter theo event + sort (trang FraudLogs)
CREATE INDEX IF NOT EXISTS "idx_fraud_logs_eventId_createdAt"
  ON "attendance_fraud_logs"("eventId", "createdAt" DESC);

-- ----- attendance_device_bindings -----
-- FK lookup userId (kiểm tra thiết bị đã bind)
CREATE INDEX IF NOT EXISTS "idx_device_bindings_userId"
  ON "attendance_device_bindings"("userId");

-- ----- attendance_otp_tokens -----
-- FK lookup userId
CREATE INDEX IF NOT EXISTS "idx_otp_tokens_userId"
  ON "attendance_otp_tokens"("userId");

-- Cleanup expired tokens
CREATE INDEX IF NOT EXISTS "idx_otp_tokens_expiresAt"
  ON "attendance_otp_tokens"("expiresAt");

-- Tìm OTP hợp lệ: userId + purpose (thường dùng nhất)
CREATE INDEX IF NOT EXISTS "idx_otp_tokens_userId_purpose"
  ON "attendance_otp_tokens"("userId", "purpose");

-- Cleanup: tokens chưa dùng + đã hết hạn
CREATE INDEX IF NOT EXISTS "idx_otp_tokens_used_expiresAt"
  ON "attendance_otp_tokens"("used", "expiresAt");

-- ----- attendance_feedback_* -----
CREATE INDEX IF NOT EXISTS "attendance_feedback_templates_createdById_idx"
  ON "attendance_feedback_templates"("createdById");

CREATE INDEX IF NOT EXISTS "attendance_feedback_forms_templateId_idx"
  ON "attendance_feedback_forms"("templateId");

CREATE INDEX IF NOT EXISTS "attendance_feedback_responses_formId_idx"
  ON "attendance_feedback_responses"("formId");

CREATE INDEX IF NOT EXISTS "attendance_feedback_responses_userId_idx"
  ON "attendance_feedback_responses"("userId");

-- ----- attendance_event_reminders -----
CREATE INDEX IF NOT EXISTS "attendance_event_reminders_eventId_createdAt_idx"
  ON "attendance_event_reminders"("eventId", "createdAt");

CREATE INDEX IF NOT EXISTS "attendance_event_reminders_triggeredById_idx"
  ON "attendance_event_reminders"("triggeredById");

-- ----- attendance_certificates -----
CREATE INDEX IF NOT EXISTS "attendance_certificates_userId_idx"
  ON "attendance_certificates"("userId");

CREATE INDEX IF NOT EXISTS "attendance_certificates_issuedById_idx"
  ON "attendance_certificates"("issuedById");

-- ----- attendance_event_guests -----
CREATE INDEX IF NOT EXISTS "attendance_event_guests_eventId_idx"
  ON "attendance_event_guests"("eventId");

CREATE INDEX IF NOT EXISTS "attendance_event_guests_eventId_checkedInAt_idx"
  ON "attendance_event_guests"("eventId", "checkedInAt");

CREATE INDEX IF NOT EXISTS "attendance_event_guest_keys_guestId_idx"
  ON "attendance_event_guest_keys"("guestId");

CREATE INDEX IF NOT EXISTS "attendance_event_guest_seats_guestId_idx"
  ON "attendance_event_guest_seats"("guestId");

-- ============================================================
-- BƯỚC 6: Trigger tự động cập nhật updatedAt
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "attendance_users_updated_at" ON "attendance_users";
CREATE TRIGGER "attendance_users_updated_at"
  BEFORE UPDATE ON "attendance_users"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_events_updated_at" ON "attendance_events";
CREATE TRIGGER "attendance_events_updated_at"
  BEFORE UPDATE ON "attendance_events"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_records_updated_at" ON "attendance_records";
CREATE TRIGGER "attendance_records_updated_at"
  BEFORE UPDATE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_feedback_templates_updated_at" ON "attendance_feedback_templates";
CREATE TRIGGER "attendance_feedback_templates_updated_at"
  BEFORE UPDATE ON "attendance_feedback_templates"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_feedback_forms_updated_at" ON "attendance_feedback_forms";
CREATE TRIGGER "attendance_feedback_forms_updated_at"
  BEFORE UPDATE ON "attendance_feedback_forms"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_certificate_templates_updated_at" ON "attendance_certificate_templates";
CREATE TRIGGER "attendance_certificate_templates_updated_at"
  BEFORE UPDATE ON "attendance_certificate_templates"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_event_guests_updated_at" ON "attendance_event_guests";
CREATE TRIGGER "attendance_event_guests_updated_at"
  BEFORE UPDATE ON "attendance_event_guests"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_invitation_templates_updated_at" ON "attendance_invitation_templates";
CREATE TRIGGER "attendance_invitation_templates_updated_at"
  BEFORE UPDATE ON "attendance_invitation_templates"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_feedback_responses_updated_at" ON "attendance_feedback_responses";
CREATE TRIGGER "attendance_feedback_responses_updated_at"
  BEFORE UPDATE ON "attendance_feedback_responses"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS "attendance_face_profiles_updated_at" ON "attendance_face_profiles";
CREATE TRIGGER "attendance_face_profiles_updated_at"
  BEFORE UPDATE ON "attendance_face_profiles"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- BƯỚC 7: Seed data - Tài khoản demo
-- Mật khẩu được hash bằng bcrypt (pgcrypto)
-- ============================================================
INSERT INTO "attendance_users"
  ("id", "mssv", "email", "name", "role", "passwordHash", "isFirstLogin", "isActive", "createdAt", "updatedAt")
VALUES
  (
    'seed_admin_001',
    NULL,
    'admin@fpt.edu.vn',
    'System Admin',
    'ADMIN',
    crypt('Admin@123', gen_salt('bf', 10)),
    FALSE,
    TRUE,
    NOW(),
    NOW()
  ),
  (
    'seed_btc_001',
    NULL,
    'btc@fpt.edu.vn',
    'Ban Tổ Chức',
    'BTC',
    crypt('Btc@123456', gen_salt('bf', 10)),
    FALSE,
    TRUE,
    NOW(),
    NOW()
  ),
  (
    'seed_student_001',
    'SE123456',
    'se123456@fpt.edu.vn',
    'Nguyễn Văn An',
    'STUDENT',
    crypt('Student@123', gen_salt('bf', 10)),
    FALSE,
    TRUE,
    NOW(),
    NOW()
  )
ON CONFLICT ("email") DO NOTHING;

-- ============================================================
-- BƯỚC 8: Kiểm tra kết quả
-- ============================================================
SELECT
  tablename,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_name = tablename AND table_schema = 'public') AS col_count
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'attendance_%'
ORDER BY tablename;

SELECT
  indexname,
  tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename LIKE 'attendance_%'
ORDER BY tablename, indexname;
