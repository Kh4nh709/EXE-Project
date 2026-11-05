const prisma = require('./prisma');

// Quy tắc dữ liệu khuôn mặt cho check-in tại cửa. Mọi lần ghi FaceProfile phải đi qua
// đây — đừng tự giải mã/so vector ở controller.
//
// Embedding do TRÌNH DUYỆT tính bằng @vladmandic/human (mô-đun faceres, 1024 số) cả lúc
// đăng ký lẫn ở kiosk; server không chạy mô hình (Render free tier không đủ RAM) mà chỉ
// lưu và so vector. Vì vậy hàm similarity và các ngưỡng dưới đây PHẢI trùng với
// frontend/src/pages/face/faceMatch.js — sửa một bên thì sửa bên kia, giống cặp
// certificateLayout.

// Đổi mô hình (hoặc phiên bản Human làm vector khác đi) thì đổi chuỗi này: profile cũ
// tự bị bỏ qua và sinh viên phải đăng ký lại, thay vì so vector của hai mô hình với nhau.
const FACE_MODEL = 'human-3.3.6-faceres';
const EMBEDDING_DIM = 1024;
const EMBEDDING_BYTES = EMBEDDING_DIM * 4;

// Hai người KHÁC nhau giống nhau tới mức này thì kiosk có thể tự check-in nhầm người →
// không cho lưu (chống A đăng ký mặt của B để B đi qua cửa là A có mặt).
const DUPLICATE_THRESHOLD = 0.6;
// Ảnh tự chụp phải giống ảnh admin đã import ít nhất mức này mới được thay ảnh import.
// Thấp hơn ngưỡng trùng vì ảnh thẻ thường chụp từ vài năm trước.
const SELF_VS_IMPORT_THRESHOLD = 0.5;

const MAX_THUMBNAIL_BYTES = 20 * 1024;
// Một lô import tính embedding trong trình duyệt admin rồi gửi lên; trần để một request
// không quét cả bảng profile quá nhiều lần (mỗi item chạy findDuplicate trên RAM).
const MAX_IMPORT_ITEMS = 50;

// Cùng công thức với human.match.similarity (order 2, multiplier 20): 0..1, trên ~0.5
// là cùng một người. Không làm tròn ở cả hai phía để kết quả khớp tuyệt đối.
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  if (sum === 0) return 1;
  return Math.max(0, Math.min(1, 1 - Math.sqrt(20 * sum) / 100));
}

// base64 của Float32Array little-endian → { buffer } hoặc { error }. Giữ lại Buffer
// nguyên bản để ghi thẳng vào cột BYTEA.
function decodeEmbedding(value) {
  if (typeof value !== 'string' || !value) return { error: 'Thiếu dữ liệu khuôn mặt' };
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== EMBEDDING_BYTES) return { error: 'Dữ liệu khuôn mặt không hợp lệ' };
  const vector = toVector(buffer);
  let norm = 0;
  for (const v of vector) {
    if (!Number.isFinite(v)) return { error: 'Dữ liệu khuôn mặt không hợp lệ' };
    norm += v * v;
  }
  // Vector toàn 0 = trình duyệt không tính được gì; mọi khuôn mặt sẽ "giống" nó như nhau.
  if (norm === 0) return { error: 'Dữ liệu khuôn mặt không hợp lệ' };
  return { buffer, vector };
}

function toVector(buffer) {
  const vector = new Array(buffer.length / 4);
  for (let i = 0; i < vector.length; i++) vector[i] = buffer.readFloatLE(i * 4);
  return vector;
}

// Thumbnail là JPEG nhỏ trình duyệt cắt sẵn. Tuỳ chọn: thiếu thì kiosk chỉ hiện tên.
function decodeThumbnail(value) {
  if (value === undefined || value === null || value === '') return { buffer: null };
  if (typeof value !== 'string') return { error: 'Ảnh thu nhỏ không hợp lệ' };
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return { error: 'Ảnh thu nhỏ phải là JPEG' };
  }
  if (buffer.length > MAX_THUMBNAIL_BYTES) return { error: 'Ảnh thu nhỏ quá lớn' };
  return { buffer };
}

// Profile kiosk được dùng: đúng mô hình hiện tại và đã được kích hoạt (sinh viên đồng ý khi tự
// chụp, hoặc admin đặt ảnh). Ảnh import cũ trước khi đổi quy tắc có thể vẫn chờ đồng ý.
function isActiveProfile(profile) {
  return Boolean(profile && profile.model === FACE_MODEL && profile.consentAt);
}

function profileStatus(profile) {
  if (!profile || profile.model !== FACE_MODEL) return 'none';
  return profile.consentAt ? 'active' : 'pending-consent';
}

// Dữ liệu ghi khi ADMIN đặt ảnh (import theo lô hoặc thay ảnh từng người). Có hiệu lực NGAY
// (consentAt = lúc admin đặt): chủ sản phẩm quyết định nhà trường chịu trách nhiệm cơ sở pháp
// lý cho ảnh mình cung cấp, không bắt sinh viên bấm đồng ý. Sinh viên vẫn xoá được ở /khuon-mat.
// importEmbedding = ảnh mới để ảnh tự chụp sau này phải giống nó — ai tự chụp mặt người khác
// thay vào sẽ bị FACE_MISMATCH.
function adminProfileData(embedding, thumbnail) {
  return {
    embedding: embedding.buffer,
    importEmbedding: embedding.buffer,
    thumbnail: thumbnail.buffer,
    model: FACE_MODEL,
    source: 'IMPORT',
    consentAt: new Date(),
  };
}

// Mọi profile cùng mô hình, đã giải mã — import một lô thì nạp MỘT lần rồi so trên RAM.
// Gồm cả ảnh chưa đồng ý: ảnh import của B vẫn phải chặn A đăng ký mặt B.
async function loadProfileVectors() {
  const profiles = await prisma.faceProfile.findMany({
    where: { model: FACE_MODEL },
    select: { userId: true, embedding: true },
  });
  return profiles.map((p) => ({ userId: p.userId, vector: toVector(Buffer.from(p.embedding)) }));
}

// Người khác (khác exceptUserId) có vector quá giống → { userId, similarity }, không thì
// null. Vài nghìn vector × 1024 số vẫn chỉ vài chục ms trên Node.
function findDuplicateIn(vector, profiles, exceptUserId) {
  let best = null;
  for (const p of profiles) {
    if (p.userId === exceptUserId) continue;
    const score = similarity(vector, p.vector);
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.similarity)) {
      best = { userId: p.userId, similarity: score };
    }
  }
  return best;
}

async function findDuplicate(vector, exceptUserId) {
  return findDuplicateIn(vector, await loadProfileVectors(), exceptUserId);
}

module.exports = {
  FACE_MODEL,
  EMBEDDING_DIM,
  DUPLICATE_THRESHOLD,
  SELF_VS_IMPORT_THRESHOLD,
  MAX_IMPORT_ITEMS,
  similarity,
  decodeEmbedding,
  decodeThumbnail,
  toVector,
  isActiveProfile,
  profileStatus,
  adminProfileData,
  loadProfileVectors,
  findDuplicateIn,
  findDuplicate,
};
