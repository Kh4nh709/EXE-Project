import { useRef, useState } from 'react';
import { FolderOpen, ImageUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { faceApi } from '../../services/api';
import Button from '../../components/ui/Button';
import { Banner } from '../../components/ui/States';
import { Checkbox } from '../../components/ui/Choice';
import { cropThumbnail, detectFaces, faceProblem, loadFaceEngine, loadImageFile } from '../face/faceEngine';
import { encodeEmbedding } from '../face/faceMatch';

// Import ảnh thẻ sinh viên: tên file (bỏ đuôi) là MSSV, vd SE123456.jpg. Mô hình chạy
// ngay trong trình duyệt admin — chỉ vector + thumbnail được gửi lên, ảnh gốc không rời
// máy. Ảnh admin import có hiệu lực ngay (xem lib/faceProfile.js#adminProfileData).

// Trùng MAX_IMPORT_ITEMS của backend.
const BATCH = 50;
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

export default function FaceImport({ onDone }) {
  const [files, setFiles] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [result, setResult] = useState(null); // { updated, skipped[] }
  const [overwrite, setOverwrite] = useState(false);
  const fileRef = useRef(null);
  const folderRef = useRef(null);

  const pick = (list) => {
    const images = [...(list || [])].filter((f) => IMAGE_RE.test(f.name));
    if (!images.length) {
      toast.error('Không có ảnh .jpg/.png/.webp nào');
      return;
    }
    setFiles(images);
    setResult(null);
  };

  const run = async () => {
    setRunning(true);
    setResult(null);
    const skipped = [];
    let updated = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const { data } = await faceApi.importProfiles(batch, overwrite);
      updated += data.data.updated;
      skipped.push(...data.data.skipped);
      batch = [];
    };

    try {
      await loadFaceEngine();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const mssv = file.name.replace(/\.[^.]+$/, '').trim();
        setProgress({ done: i, total: files.length });
        try {
          const img = await loadImageFile(file);
          const faces = await detectFaces(img);
          // Ảnh thẻ: đúng một khuôn mặt. Không kiểm liveness — ảnh chụp lại luôn "không sống".
          const problem = faces.length > 1 ? 'Ảnh có nhiều hơn một khuôn mặt' : faceProblem(faces[0], { live: false });
          if (problem) {
            skipped.push({ mssv, reason: problem });
            continue;
          }
          batch.push({ mssv, embedding: encodeEmbedding(faces[0].embedding), thumbnail: cropThumbnail(img, faces[0]) });
        } catch {
          skipped.push({ mssv, reason: 'Không đọc được ảnh' });
        }
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      setProgress({ done: files.length, total: files.length });
      setResult({ updated, skipped });
      if (updated) onDone?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Import thất bại — các ảnh đã gửi trước đó vẫn được lưu.');
      setResult({ updated, skipped });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-background p-4 text-sm">
        <p className="font-medium text-foreground">Đặt tên file theo MSSV</p>
        <p className="mt-2 overflow-x-auto rounded-lg bg-surface px-3 py-2 font-mono text-xs text-foreground">SE123456.jpg · SE123457.png</p>
        <p className="mt-2 text-pretty text-xs text-muted">
          Mỗi ảnh một khuôn mặt, chụp chính diện. Ảnh được xử lý ngay trên máy này; chỉ đặc trưng khuôn mặt và ảnh thu nhỏ
          được lưu. Kiosk dùng ảnh ngay sau khi import.
        </p>
      </div>

      <Checkbox
        checked={overwrite}
        disabled={running}
        onChange={(e) => setOverwrite(e.target.checked)}
        label="Ghi đè cả ảnh sinh viên đã tự chụp"
        desc={overwrite
          ? 'Ảnh mới thay ảnh tự chụp và kiosk dùng ngay.'
          : 'Đang tắt: sinh viên đã tự chụp và đang dùng sẽ được giữ nguyên ảnh.'}
      />

      <div className="flex flex-wrap gap-2">
        <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => pick(e.target.files)} />
        <input ref={folderRef} type="file" webkitdirectory="" multiple className="sr-only" onChange={(e) => pick(e.target.files)} />
        <Button size="form" icon={ImageUp} disabled={running} onClick={() => fileRef.current?.click()}>Chọn ảnh</Button>
        <Button size="form" icon={FolderOpen} disabled={running} onClick={() => folderRef.current?.click()}>Chọn cả thư mục</Button>
      </div>

      {files.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm tabular-nums text-muted">
            {progress && running ? `Đang xử lý ${progress.done}/${progress.total} ảnh…` : `${files.length} ảnh đã chọn`}
          </p>
          <Button variant="primary" size="form" loading={running} onClick={run}>Import</Button>
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <Banner tone={result.skipped.length ? 'warning' : 'info'} compact title={`Đã lưu ${result.updated} ảnh · bỏ qua ${result.skipped.length}`} />
          {result.skipped.length > 0 && (
            <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-xl border border-border text-sm">
              {result.skipped.map((s, i) => (
                <li key={`${s.mssv}-${i}`} className="flex gap-3 px-3 py-2">
                  <span className="w-28 shrink-0 font-mono text-xs text-foreground">{s.mssv}</span>
                  <span className="min-w-0 text-pretty text-muted">{s.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
