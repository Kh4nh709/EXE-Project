import { useRef, useState } from 'react';
import { FileSpreadsheet, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import Button from '../ui/Button';
import { Textarea } from '../ui/Input';
import { Banner } from '../ui/States';
import { parsePastedParticipants } from '../../utils/participants';

// Nhập người tham gia — dùng chung cho danh sách sự kiện và danh sách lớp. Người tham
// gia không có tài khoản: BTC chỉ cần email + họ tên (MSSV tuỳ chọn), backend tự tạo
// người còn thiếu (lib/participants.js). Hai cách: dán nhiều dòng, hoặc chọn file Excel.
//   onAdd(participants) / onImport(file) → Promise trả response `{ data }` của API
//   onDone(result) — gọi khi nhập xong, trang cha tải lại danh sách và hiện kết quả
export default function ParticipantsAdder({ onAdd, onImport, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(null); // 'paste' | 'file'
  const fileRef = useRef(null);
  const rows = parsePastedParticipants(text);

  const run = async (kind, call) => {
    setBusy(kind);
    try {
      const { data } = await call();
      toast.success(data.message || 'Đã thêm vào danh sách');
      setText('');
      onDone?.(data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Thêm thất bại');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <label htmlFor="participants-paste" className="text-sm font-medium text-foreground">Dán danh sách</label>
        <Textarea
          id="participants-paste"
          rows={6}
          className="resize-y font-mono text-xs"
          placeholder={'an@fpt.edu.vn, Nguyễn Văn An, SE170001\nbinh@fpt.edu.vn, Trần Bình'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-pretty text-xs text-muted">
          Mỗi dòng một người: email, họ tên, MSSV (không bắt buộc). Dán thẳng các cột từ Excel cũng được.
          Người tham gia không cần tài khoản — check-in bằng mã QR + email hoặc khuôn mặt.
        </p>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="form"
            icon={UserPlus}
            loading={busy === 'paste'}
            disabled={rows.length === 0 || Boolean(busy)}
            onClick={() => run('paste', () => onAdd(rows))}
          >
            {rows.length ? `Thêm ${rows.length} người` : 'Thêm'}
          </Button>
        </div>
      </section>

      <div className="flex items-center gap-3 text-xs text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />hoặc<span className="h-px flex-1 bg-border" />
      </div>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium text-foreground">Nhập từ file Excel / CSV</p>
        <p className="text-pretty text-xs text-muted">
          Dòng đầu là tiêu đề, cần cột <span className="font-medium text-foreground">Email</span> và{' '}
          <span className="font-medium text-foreground">Họ tên</span>; cột MSSV, SĐT không bắt buộc.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) run('file', () => onImport(file));
          }}
        />
        <div>
          <Button size="form" icon={FileSpreadsheet} loading={busy === 'file'} disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>
            Chọn file
          </Button>
        </div>
      </section>
    </div>
  );
}

// Kết quả lần nhập gần nhất: số đã thêm và các dòng bị bỏ qua kèm lý do.
export function ImportResult({ result, onClose }) {
  if (!result) return null;
  const skipped = result.skipped || [];
  return (
    <Banner
      tone={skipped.length ? 'warning' : 'info'}
      compact
      title={result.message}
      action={<Button variant="ghost" size="sm" onClick={onClose}>Đóng</Button>}
    >
      {skipped.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
          {skipped.slice(0, 100).map((s, i) => (
            <li key={`${s.line}-${i}`} className="text-pretty">
              <span className="tabular-nums">Dòng {s.line}</span>
              {s.email ? ` · ${s.email}` : s.name ? ` · ${s.name}` : ''} — {s.reason}
            </li>
          ))}
          {skipped.length > 100 && <li>… và {skipped.length - 100} dòng khác</li>}
        </ul>
      )}
    </Banner>
  );
}
