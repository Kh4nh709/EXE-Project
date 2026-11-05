import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ImageUp, ScanFace, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { faceApi } from '../../services/api';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Modal, { useConfirm } from '../../components/ui/Modal';
import { Banner, LoadError, Skeleton } from '../../components/ui/States';
import { cropThumbnail, detectFaces, faceProblem, loadFaceEngine, loadImageFile } from '../face/faceEngine';
import { encodeEmbedding } from '../face/faceMatch';

// Admin xem / thay / xoá ảnh khuôn mặt check-in của MỘT người. Giống FaceImport: mô hình
// chạy trong trình duyệt admin, chỉ vector + thumbnail được gửi lên. Ảnh admin đặt có hiệu
// lực ngay (lib/faceProfile.js#adminProfileData).

export const FACE_STATUS = {
  active: { tone: 'success', label: 'Đang dùng' },
  'pending-consent': { tone: 'warning', label: 'Chờ SV đồng ý' },
  none: { tone: 'neutral', label: 'Chưa có' },
};

function FaceTile({ thumbnail, caption, alt }) {
  return (
    <figure className="flex flex-col items-center gap-2">
      {thumbnail ? (
        <img src={`data:image/jpeg;base64,${thumbnail}`} alt={alt} className="size-28 rounded-xl object-cover" />
      ) : (
        <span className="flex size-28 items-center justify-center rounded-xl bg-background text-muted">
          <ScanFace className="size-10" aria-hidden="true" />
        </span>
      )}
      {caption && <figcaption className="text-xs text-muted">{caption}</figcaption>}
    </figure>
  );
}

// user = null → đóng. onChanged(userId, status) để bảng cập nhật cột trạng thái tại chỗ.
export default function UserFaceModal({ user: openUser, onClose, onChanged }) {
  // Giữ người vừa mở để nội dung không biến mất giữa chừng lúc modal chạy hiệu ứng đóng.
  const lastUser = useRef(openUser);
  if (openUser) lastUser.current = openUser;
  const user = openUser || lastUser.current;
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [candidate, setCandidate] = useState(null); // { embedding, thumbnail }
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isStudent = user?.role === 'STUDENT';

  const load = async (id) => {
    setLoadError(false);
    setProfile(null);
    try {
      const { data } = await faceApi.getUserFace(id);
      setProfile(data.data);
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    setCandidate(null);
    if (openUser) load(openUser.id);
  }, [openUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = async (file) => {
    if (!file) return;
    setProcessing(true);
    try {
      await loadFaceEngine();
      const img = await loadImageFile(file);
      const faces = await detectFaces(img);
      // Ảnh có sẵn (ảnh thẻ, ảnh chụp lại) → không kiểm liveness, như import theo lô.
      const problem = faces.length > 1 ? 'Ảnh có nhiều hơn một khuôn mặt' : faceProblem(faces[0], { live: false });
      if (problem) {
        toast.error(problem);
        return;
      }
      setCandidate({ embedding: encodeEmbedding(faces[0].embedding), thumbnail: cropThumbnail(img, faces[0]) });
    } catch {
      toast.error('Không đọc được ảnh');
    } finally {
      setProcessing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await faceApi.setUserFace(user.id, candidate);
      setProfile(data.data);
      setCandidate(null);
      toast.success(data.message);
      onChanged?.(user.id, data.data.status);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Không lưu được ảnh');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({
      title: 'Xoá ảnh khuôn mặt?',
      body: <>Kiosk sẽ không nhận ra <span className="font-medium text-foreground">{user.name}</span> nữa cho tới khi có ảnh mới.</>,
      confirmLabel: 'Xoá ảnh',
    }))) return;
    setDeleting(true);
    try {
      const { data } = await faceApi.deleteUserFace(user.id);
      toast.success(data.message);
      setProfile({ status: 'none' });
      onChanged?.(user.id, 'none');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Không xoá được');
    } finally {
      setDeleting(false);
    }
  };

  const busy = processing || saving || deleting;
  const hasFace = profile && profile.status !== 'none';
  const badge = profile ? FACE_STATUS[profile.status] : null;

  let body;
  if (!user) body = null;
  else if (loadError) body = <LoadError title="Không tải được ảnh khuôn mặt" onRetry={() => load(user.id)} />;
  else if (!profile) body = <Skeleton className="h-28 w-full" />;
  else {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-center gap-4">
          <FaceTile
            thumbnail={profile.thumbnail}
            alt={`Ảnh khuôn mặt hiện tại của ${user.name}`}
            caption={candidate ? 'Hiện tại' : null}
          />
          {candidate && (
            <>
              <ArrowRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
              <FaceTile thumbnail={candidate.thumbnail} alt="Ảnh khuôn mặt mới" caption="Ảnh mới" />
            </>
          )}
        </div>

        {!candidate && (
          <div className="flex flex-col items-center gap-1 text-center">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {hasFace && (
              <p className="text-sm text-muted">
                {profile.source === 'IMPORT' ? 'Ảnh do admin cung cấp' : 'Sinh viên tự chụp'}
                {profile.updatedAt && ` · ${format(new Date(profile.updatedAt), 'dd/MM/yyyy HH:mm')}`}
              </p>
            )}
          </div>
        )}

        {isStudent ? (
          <p className="text-pretty text-sm text-muted">
            {candidate
              ? 'Ảnh mới sẽ thay ảnh hiện tại, kiosk dùng ngay sau khi lưu.'
              : 'Chọn một ảnh chụp chính diện, chỉ một khuôn mặt. Ảnh được xử lý ngay trên máy này; chỉ đặc trưng khuôn mặt và ảnh thu nhỏ được lưu.'}
          </p>
        ) : (
          <Banner tone="info" compact title="Check-in bằng khuôn mặt chỉ dành cho tài khoản sinh viên" />
        )}

        {!candidate && (
          <div className="flex flex-wrap justify-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            {isStudent && (
              <Button size="form" icon={ImageUp} loading={processing} disabled={busy} onClick={() => fileRef.current?.click()}>
                {processing ? 'Đang phân tích ảnh…' : hasFace ? 'Thay ảnh mới' : 'Tải ảnh lên'}
              </Button>
            )}
            {hasFace && (
              <Button variant="danger" size="form" icon={Trash2} loading={deleting} disabled={busy} onClick={remove}>Xoá ảnh</Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal
      open={Boolean(openUser)}
      onClose={busy ? () => {} : onClose}
      title="Ảnh khuôn mặt check-in"
      description={user ? `${user.name}${user.mssv ? ` · ${user.mssv}` : ''}` : undefined}
      size="sm"
      footer={candidate ? (
        <>
          <Button variant="secondary" size="form" disabled={saving} onClick={() => setCandidate(null)}>Chọn lại</Button>
          <Button variant="primary" size="form" loading={saving} onClick={save}>Lưu ảnh mới</Button>
        </>
      ) : (
        <Button variant="secondary" size="form" disabled={busy} onClick={onClose}>Đóng</Button>
      )}
    >
      {body}
    </Modal>
  );
}
