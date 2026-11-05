import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Camera, CameraOff, CircleCheck, CircleX, RotateCw, ScanFace, Undo2, UserCheck } from 'lucide-react';
import { format } from 'date-fns';
import { eventApi, faceApi } from '../../services/api';
import Button, { IconButton } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/Modal';
import Logo from '../../components/ui/Logo';
import { Input } from '../../components/ui/Input';
import { Banner, EmptyText } from '../../components/ui/States';
import { cx } from '../../utils/cx';
import useFaceCamera from '../face/useFaceCamera';
import { detectFaces, faceProblem, loadFaceEngine } from '../face/faceEngine';
import { CONFIRM_THRESHOLD, decide, decodeEmbedding, rankMatches } from '../face/faceMatch';

// Kiosk check-in bằng khuôn mặt — laptop của BTC đặt ở cửa. Mô hình chạy ngay trong trình
// duyệt này (faceEngine.js); danh sách vector thành viên tải một lần rồi so khớp tại chỗ,
// server chỉ nhận "userId này vừa tới". Không dùng Layout có sidebar: cần chỗ cho camera.

const GALLERY_REFRESH_MS = 60_000;
const GREETING_MS = 3500;
// Người vừa được chào còn đứng trước camera thì đừng chào lại liên tục.
const REGREET_MS = 10_000;

export default function FaceCheckin() {
  const { id } = useParams();
  const [fatal, setFatal] = useState(null);
  const [gallery, setGallery] = useState(null);
  const [engine, setEngine] = useState('loading'); // loading | ready | error
  const [hint, setHint] = useState('');
  const [greeting, setGreeting] = useState(null); // { tone: ok|already|error, title, sub, thumb }
  const [candidates, setCandidates] = useState(null); // [{ person, score, thumb }]
  const [recent, setRecent] = useState([]);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState('');
  const confirm = useConfirm();

  const peopleRef = useRef([]);
  const doneRef = useRef(new Set()); // đã check-in (từ server hoặc trong phiên này)
  // Bị BTC gỡ check-in trong phiên này — thường vì kiosk nhận nhầm mặt. Người nhầm có thể vẫn
  // đứng trước camera, nên với những id này kiosk không tự check-in nữa mà hỏi BTC chọn.
  const undoneRef = useRef(new Set());
  const streakRef = useRef({ userId: null, count: 0 });
  const greetedRef = useRef(new Map()); // userId → lúc chào gần nhất
  const thumbsRef = useRef(new Map()); // userId → object URL
  const greetTimer = useRef(null);
  const busyRef = useRef(false);

  const loadGallery = useCallback(async () => {
    try {
      const { data: res } = await faceApi.gallery(id);
      // Tải lại mỗi phút: chỉ giải mã vector của người mới/vừa đổi ảnh, còn lại dùng lại —
      // vài trăm vector × 1024 số giải mã lại mỗi lần là một cú giật thấy được trên kiosk.
      const previous = new Map(peopleRef.current.map((p) => [p.userId, p]));
      const people = res.data.people.map((p) => {
        const old = previous.get(p.userId);
        return { ...p, vector: old?.embedding === p.embedding ? old.vector : decodeEmbedding(p.embedding) };
      });
      people.forEach((p) => { if (p.checkedIn) doneRef.current.add(p.userId); });
      peopleRef.current = people;
      setGallery(res.data);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 403) setFatal('Chỉ người tạo sự kiện hoặc Admin được mở kiosk của sự kiện này.');
      else if (status === 404) setFatal('Không tìm thấy sự kiện — có thể đã bị xoá.');
      else if (status === 400) setFatal(err.response.data?.message || 'Sự kiện này không dùng check-in bằng khuôn mặt.');
    }
  }, [id]);

  useEffect(() => {
    loadGallery();
    const t = setInterval(loadGallery, GALLERY_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadGallery]);

  useEffect(() => {
    loadFaceEngine().then(() => setEngine('ready')).catch(() => setEngine('error'));
  }, []);

  useEffect(() => () => {
    clearTimeout(greetTimer.current);
    thumbsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const thumbFor = useCallback(async (userId) => {
    if (thumbsRef.current.has(userId)) return thumbsRef.current.get(userId);
    try {
      const { data } = await faceApi.thumbnail(id, userId);
      const url = URL.createObjectURL(data);
      thumbsRef.current.set(userId, url);
      return url;
    } catch {
      return null;
    }
  }, [id]);

  const greet = useCallback((g) => {
    clearTimeout(greetTimer.current);
    setGreeting(g);
    greetTimer.current = setTimeout(() => setGreeting(null), GREETING_MS);
  }, []);

  const checkIn = useCallback(async (person) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    greetedRef.current.set(person.userId, Date.now());
    const thumb = await thumbFor(person.userId);
    try {
      const { data: res } = await faceApi.checkIn(id, person.userId);
      doneRef.current.add(person.userId);
      undoneRef.current.delete(person.userId);
      greet({ tone: 'ok', title: `Xin chào ${person.name}!`, sub: person.mssv, thumb });
      setRecent((r) => [{ ...person, thumb, at: res.data.checkinTime }, ...r].slice(0, 30));
    } catch (err) {
      const code = err?.response?.data?.error;
      const message = err?.response?.data?.message || 'Không check-in được, thử lại.';
      if (code === 'ALREADY_CHECKED_IN') {
        doneRef.current.add(person.userId);
        greet({ tone: 'already', title: person.name, sub: message, thumb });
      } else {
        greet({ tone: 'error', title: person.name, sub: message, thumb });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [id, greet, thumbFor]);

  const onFrame = useCallback(async (video) => {
    if (busyRef.current || !peopleRef.current.length) return;
    const [face] = await detectFaces(video);
    const problem = faceProblem(face);
    if (problem) {
      streakRef.current = { userId: null, count: 0 };
      setHint(face ? problem : '');
      return face ? undefined : 'idle';
    }

    const ranked = rankMatches(face.embedding, peopleRef.current);
    const bestId = ranked.best?.person.userId ?? null;
    const prev = streakRef.current;
    streakRef.current = { userId: bestId, count: prev.userId === bestId ? prev.count + 1 : 1 };
    const decision = decide(ranked, streakRef.current.count);

    if (decision === 'UNKNOWN') {
      setHint('Không nhận ra — nhờ BTC check-in bằng MSSV');
      return;
    }
    if (decision === 'WAIT') {
      setHint('Đang nhận diện…');
      return;
    }

    const person = ranked.best.person;
    const lastGreet = greetedRef.current.get(person.userId) || 0;
    if (Date.now() - lastGreet < REGREET_MS) return;

    if (decision === 'AUTO' && !undoneRef.current.has(person.userId)) {
      setHint('');
      if (doneRef.current.has(person.userId)) {
        greetedRef.current.set(person.userId, Date.now());
        greet({ tone: 'already', title: person.name, sub: 'Đã check-in rồi', thumb: await thumbFor(person.userId) });
        return;
      }
      await checkIn(person);
      return;
    }

    // CONFIRM: dừng quét, hiện tối đa hai ứng viên kèm ảnh để người đứng cửa chọn.
    const list = [ranked.best, ranked.second].filter((m) => m && m.score >= CONFIRM_THRESHOLD);
    const withThumbs = await Promise.all(list.map(async (m) => ({ ...m, thumb: await thumbFor(m.person.userId) })));
    setHint('');
    setCandidates(withThumbs);
  }, [checkIn, greet, thumbFor]);

  const camera = useFaceCamera({ onFrame, paused: engine !== 'ready' || Boolean(candidates) || busy });
  const { start: startCamera, stop: stopCamera, status: cameraStatus } = camera;

  useEffect(() => {
    if (engine === 'ready' && !fatal) startCamera();
  }, [engine, fatal, startCamera]);

  const chooseCandidate = async (person) => {
    setCandidates(null);
    if (doneRef.current.has(person.userId)) {
      greetedRef.current.set(person.userId, Date.now());
      greet({ tone: 'already', title: person.name, sub: 'Đã check-in rồi', thumb: await thumbFor(person.userId) });
      return;
    }
    await checkIn(person);
  };

  const dismissCandidates = () => {
    // Bỏ qua: không chào lại ứng viên vừa bị từ chối ngay khung sau.
    candidates?.forEach((c) => greetedRef.current.set(c.person.userId, Date.now()));
    setCandidates(null);
  };

  const undoRecent = async (r) => {
    if (!(await confirm({
      title: 'Gỡ lượt check-in?',
      body: <><span className="font-medium text-foreground">{r.name}</span> sẽ trở về trạng thái “Đã đăng ký”. Dùng khi kiosk nhận nhầm người.</>,
      confirmLabel: 'Gỡ check-in',
      icon: Undo2,
    }))) return;
    try {
      await eventApi.undoCheckin(id, r.userId);
      doneRef.current.delete(r.userId);
      undoneRef.current.add(r.userId);
      greetedRef.current.set(r.userId, Date.now());
      setRecent((list) => list.filter((x) => x.userId !== r.userId));
      greet({ tone: 'already', title: 'Đã gỡ check-in', sub: r.name, thumb: r.thumb });
    } catch (err) {
      greet({ tone: 'error', title: r.name, sub: err?.response?.data?.message || 'Không gỡ được check-in' });
    }
  };

  const submitManual = async (e) => {
    e.preventDefault();
    const identifier = manual.trim();
    if (!identifier || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await eventApi.manualCheckin(id, { identifier, type: 'checkin' });
      greet({ tone: 'ok', title: 'Đã check-in', sub: identifier });
      setManual('');
    } catch (err) {
      greet({ tone: 'error', title: identifier, sub: err?.response?.data?.message || 'Không check-in được' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const gateClosed = gallery && !gallery.gate?.checkin?.open;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Button as={Link} to={`/events/${id}`} variant="ghost" size="hdr" icon={ArrowLeft}>Sự kiện</Button>
          <span className="ml-auto flex items-center gap-2 text-sm font-medium text-foreground">
            <Logo className="size-5" /> Check-in bằng khuôn mặt
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        {fatal ? (
          <div className="pt-16 text-center">
            <h1 className="text-lg font-semibold text-foreground">Không mở được kiosk</h1>
            <p className="mx-auto mt-2 max-w-sm text-pretty text-sm text-muted">{fatal}</p>
            <Button as={Link} to="/events" size="form" className="mt-6">Về danh sách sự kiện</Button>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-3">
              {gateClosed && (
                <Banner tone="warning" title="Cổng check-in đang đóng">
                  Kiosk vẫn nhận diện nhưng sẽ không chấm được. Mở cổng check-in ở trang sự kiện.
                </Banner>
              )}
              {gallery && gallery.withFace === 0 && (
                <Banner tone="info" title="Chưa ai trong danh sách bật check-in bằng khuôn mặt">
                  Sinh viên tự đăng ký ở mục “Khuôn mặt” trong tài khoản, hoặc đồng ý dùng ảnh nhà trường đã import.
                </Banner>
              )}

              <div className="relative overflow-hidden rounded-2xl bg-black">
                {/* Lật ngang như soi gương — người đứng trước camera dễ căn mặt hơn. */}
                <video ref={camera.videoRef} muted playsInline className="aspect-video w-full -scale-x-100 object-cover" />

                {cameraStatus === 'running' && !greeting && !candidates && hint && (
                  <p className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-full bg-black/60 px-4 py-1.5 text-sm text-white">{hint}</p>
                )}

                {cameraStatus !== 'running' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
                    {engine === 'loading' && <><ScanFace className="size-8 animate-pulse" aria-hidden="true" /><p className="text-sm">Đang tải mô hình nhận diện…</p></>}
                    {engine === 'error' && (
                      <>
                        <CameraOff className="size-8" aria-hidden="true" />
                        <p className="text-pretty text-sm">Không tải được mô hình nhận diện. Kiểm tra mạng rồi tải lại trang.</p>
                      </>
                    )}
                    {engine === 'ready' && cameraStatus === 'starting' && <><Camera className="size-8 animate-pulse" aria-hidden="true" /><p className="text-sm">Đang mở camera…</p></>}
                    {engine === 'ready' && cameraStatus === 'idle' && (
                      <Button variant="primary" size="form" icon={Camera} onClick={startCamera}>Bật camera</Button>
                    )}
                    {['denied', 'unsupported', 'error'].includes(cameraStatus) && (
                      <>
                        <CameraOff className="size-8" aria-hidden="true" />
                        <p className="text-pretty text-sm">
                          {cameraStatus === 'denied'
                            ? 'Trình duyệt chưa được phép dùng camera. Mở cài đặt trang (biểu tượng ổ khoá trên thanh địa chỉ) để cho phép, rồi thử lại.'
                            : 'Không mở được camera — có thể ứng dụng khác đang dùng.'}
                        </p>
                        <Button size="form" icon={RotateCw} onClick={() => { stopCamera(); startCamera(); }}>Thử lại</Button>
                      </>
                    )}
                  </div>
                )}

                {greeting && <GreetingCard greeting={greeting} />}

                {candidates && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4">
                    <div className="w-full max-w-md rounded-2xl bg-surface p-4 shadow-modal">
                      <p className="text-sm font-semibold text-foreground">Đây có phải là…</p>
                      <p className="mt-0.5 text-xs text-muted">Chưa đủ chắc để tự check-in. Đối chiếu ảnh rồi chọn đúng người.</p>
                      <ul className="mt-3 flex flex-col gap-2">
                        {candidates.map((c) => (
                          <li key={c.person.userId}>
                            <button
                              type="button"
                              onClick={() => chooseCandidate(c.person)}
                              className="flex w-full items-center gap-3 rounded-xl border border-border p-2 text-left hover:bg-item-hover"
                            >
                              <Thumb src={c.thumb} className="size-14" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-foreground">{c.person.name}</span>
                                <span className="block text-xs tabular-nums text-muted">{c.person.mssv} · giống {Math.round(c.score * 100)}%</span>
                              </span>
                              <UserCheck className="size-5 shrink-0 text-muted" aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                      <Button size="form" className="mt-3 w-full" onClick={dismissCandidates}>Không phải ai trong số này</Button>
                    </div>
                  </div>
                )}
              </div>

              <form onSubmit={submitManual} className="flex gap-2">
                <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Không nhận ra? Nhập MSSV hoặc email để check-in tay" />
                <Button type="submit" size="form" className="shrink-0 whitespace-nowrap" loading={busy && Boolean(manual)}>Check-in</Button>
              </form>
            </div>

            <aside className="flex flex-col gap-3">
              {gallery && (
                <div className="rounded-2xl border border-border bg-surface p-4">
                  <p className="text-sm text-muted">
                    <span className="text-2xl font-semibold tabular-nums text-foreground">{gallery.withFace}</span>
                    /{gallery.totalMembers} thành viên đã bật khuôn mặt
                  </p>
                  {gallery.totalMembers > gallery.withFace && (
                    <p className="mt-1 text-pretty text-xs text-muted">
                      {gallery.totalMembers - gallery.withFace} người còn lại cần check-in bằng QR hoặc MSSV.
                    </p>
                  )}
                </div>
              )}
              <section className="rounded-2xl border border-border bg-surface p-4">
                <h2 className="text-sm font-semibold text-foreground">Vừa check-in tại kiosk</h2>
                {recent.length === 0 ? (
                  <EmptyText className="py-4">Chưa có ai.</EmptyText>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {recent.map((r) => (
                      <li key={`${r.userId}-${r.at}`} className="flex items-center gap-3">
                        <Thumb src={r.thumb} className="size-9" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground">{r.name}</span>
                          <span className="block text-xs tabular-nums text-muted">{r.mssv}</span>
                        </span>
                        <span className="text-xs tabular-nums text-muted">{format(new Date(r.at), 'HH:mm')}</span>
                        <IconButton icon={Undo2} label={`Gỡ check-in của ${r.name}`} danger onClick={() => undoRecent(r)} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}

const GREETING_TONE = {
  ok: { icon: CircleCheck, cls: 'text-success' },
  already: { icon: CircleCheck, cls: 'text-muted' },
  error: { icon: CircleX, cls: 'text-error-strong' },
};

// Tên + ảnh đã đăng ký thật to: người đứng cửa nhìn là biết kiosk có nhận đúng người không
// (lớp chặn cuối cùng cho trường hợp ai đó đăng ký mặt của người khác).
function GreetingCard({ greeting }) {
  const tone = GREETING_TONE[greeting.tone];
  const Icon = tone.icon;
  return (
    <div className="absolute inset-x-3 bottom-3 flex items-center gap-4 rounded-2xl bg-surface p-4 shadow-modal" role="status">
      {greeting.thumb !== undefined && <Thumb src={greeting.thumb} className="size-20" />}
      <div className="min-w-0 flex-1">
        <p className={cx('flex items-center gap-2 text-xl font-semibold', tone.cls)}>
          <Icon className="size-6 shrink-0" aria-hidden="true" />
          <span className="truncate">{greeting.title}</span>
        </p>
        {greeting.sub && <p className="mt-1 text-pretty text-sm text-muted">{greeting.sub}</p>}
      </div>
    </div>
  );
}

function Thumb({ src, className }) {
  return src
    ? <img src={src} alt="" className={cx('shrink-0 rounded-xl object-cover', className)} />
    : <span className={cx('flex shrink-0 items-center justify-center rounded-xl bg-background text-muted', className)}><ScanFace className="size-1/2" aria-hidden="true" /></span>;
}
