// Đọc danh sách người tham gia BTC dán vào ô văn bản: mỗi dòng một người, các cột
// cách nhau bằng tab (dán thẳng từ Excel), dấu phẩy hoặc chấm phẩy, thứ tự tuỳ ý.
// Nhận diện theo nội dung: ô có "@" là email, ô dạng SE170001 là MSSV, ô chữ còn lại
// là họ tên; ô chỉ có số (cột STT) bị bỏ qua. Kiểm tra hợp lệ thật nằm ở backend
// (lib/participants.js) — dòng sai được trả về kèm lý do.

const MSSV_RE = /^[A-Za-z]{2,3}\d{5,7}$/;

export function parsePastedParticipants(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Dòng tiêu đề dán kèm từ Excel ("Email  Họ tên  MSSV") — không có "@" nên bỏ.
  if (lines.length && !lines[0].includes('@') && /e-?mail/i.test(lines[0])) lines.shift();

  return lines.map((line) => {
    const row = { email: '', name: '', mssv: '' };
    for (const cell of line.split(/[\t,;]/).map((c) => c.trim()).filter(Boolean)) {
      if (!row.email && cell.includes('@')) row.email = cell;
      else if (!row.mssv && MSSV_RE.test(cell)) row.mssv = cell;
      else if (!row.name && !/^\d+$/.test(cell)) row.name = cell;
    }
    return row;
  });
}
