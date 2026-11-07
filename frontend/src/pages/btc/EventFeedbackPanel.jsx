import { useState, useEffect, useCallback } from 'react';
import { ChartColumn, Ellipsis, EyeOff, FileText, ListPlus, Lock, Pencil, Play, Square, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { feedbackApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import Modal, { useConfirm } from '../../components/ui/Modal';
import Button, { OutlineIconButton } from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Select from '../../components/ui/Select';
import Dropdown, { MenuGroup, MenuItem, MenuSeparator } from '../../components/ui/Dropdown';
import { Card } from '../../components/ui/Card';
import { Field, Input, Textarea } from '../../components/ui/Input';
import { Checkbox, Switch } from '../../components/ui/Choice';
import { LoadError, Skeleton } from '../../components/ui/States';
import QuestionListEditor, { newQuestion, questionListError } from '../feedback/QuestionListEditor';
import FeedbackResultsModal from './FeedbackResultsModal';

// Khung "Đánh giá sau sự kiện" trong trang chi tiết sự kiện: gắn form (từ mẫu
// hoặc tự soạn), mở/đóng, bật ẩn danh và xem kết quả. Quyền do backend quyết
// (loadEventForWrite) — 403 thì ẩn cả khung (onUnavailable để trang cha ẩn tab).
export default function EventFeedbackPanel({ eventId, eventName, onUnavailable }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = ['ADMIN', 'BTC'].includes(user?.role);

  const [state, setState] = useState(null); // { form, responseCount, eligibleCount }
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(null); // tên thao tác đang chạy

  const [templates, setTemplates] = useState(null);
  const [templateId, setTemplateId] = useState('');
  const [anonymous, setAnonymous] = useState(false);

  const [editor, setEditor] = useState(null); // null | { title, description, questions }
  const [resultsOpen, setResultsOpen] = useState(false);

  const load = useCallback(() => {
    feedbackApi.getEventForm(eventId)
      .then(({ data }) => setState(data.data))
      .catch((err) => {
        if (err.response?.status === 403) { setHidden(true); onUnavailable?.(); }
        else setState({ error: true });
      });
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // Danh sách mẫu chỉ cần khi chưa có form hoặc đang soạn.
  useEffect(() => {
    if (!canWrite || templates !== null) return;
    if (state && (!state.form || editor)) {
      feedbackApi.listTemplates()
        .then(({ data }) => setTemplates(data.data || []))
        .catch(() => setTemplates([]));
    }
  }, [state, editor, canWrite, templates]);

  if (hidden) return null;

  const cardProps = { title: 'Đánh giá sau sự kiện', sub: 'Chỉ người đã check-out mới gửi được đánh giá' };

  if (!state) {
    return (
      <Card {...cardProps}>
        <div className="space-y-3"><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-3/5" /><Skeleton className="h-3 w-2/5" /></div>
      </Card>
    );
  }

  // Lỗi mạng: KHÔNG rơi xuống giao diện "chưa có form" — BTC có thể bấm gắn mẫu
  // và ghi đè form đang có.
  if (state.error) {
    return (
      <Card {...cardProps}>
        <LoadError title="Không tải được form đánh giá" reason="" onRetry={() => { setState(null); load(); }} className="py-4" />
      </Card>
    );
  }

  const { form, responseCount, eligibleCount } = state;
  const locked = responseCount > 0;

  const run = async (name, fn, success) => {
    setBusy(name);
    try {
      await fn();
      if (success) toast.success(success);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Thao tác thất bại');
    } finally {
      setBusy(null);
    }
  };

  const attachTemplate = () => {
    if (!templateId) return toast.error('Chọn một mẫu đánh giá');
    run('attach', () => feedbackApi.saveEventForm(eventId, { templateId, isAnonymous: anonymous }), 'Đã gắn form đánh giá');
  };

  const openEditor = () => {
    setEditor(form
      ? { title: form.title, description: form.description || '', questions: form.questions }
      : { title: `Đánh giá sự kiện: ${eventName}`, description: '', questions: [newQuestion('RATING'), { ...newQuestion('TEXT'), required: false }] });
  };

  const loadTemplateIntoEditor = (id) => {
    const tpl = templates?.find((t) => t.id === id);
    if (!tpl) return;
    setEditor((ed) => ({ ...ed, questions: tpl.questions.map((q) => ({ ...q })), description: ed.description || tpl.description || '' }));
  };

  const saveEditor = async (e) => {
    e.preventDefault();
    if (!editor.title.trim()) return toast.error('Vui lòng nhập tiêu đề form');
    const qErr = questionListError(editor.questions);
    if (qErr) return toast.error(qErr);
    await run('save', async () => {
      await feedbackApi.saveEventForm(eventId, {
        ...editor,
        ...(!form && { isAnonymous: anonymous }),
      });
      setEditor(null);
    }, form ? 'Đã lưu câu hỏi' : 'Đã tạo form đánh giá');
  };

  const setOpen = (isOpen) => run('open', () => feedbackApi.setEventFormState(eventId, { isOpen }),
    isOpen ? 'Đã mở form đánh giá' : 'Đã đóng form đánh giá');

  const toggleAnonymous = async (isAnonymous) => {
    if (isAnonymous && locked && !(await confirm({
      title: 'Bật ẩn danh?',
      body: 'Sau khi bật, bạn sẽ không thể tắt lại vì đã có người trả lời.',
      confirmLabel: 'Bật ẩn danh',
      tone: 'neutral',
      icon: EyeOff,
    }))) return;
    run('anon', () => feedbackApi.setEventFormState(eventId, { isAnonymous }));
  };

  const removeForm = async () => {
    if (!(await confirm({
      title: 'Gỡ form đánh giá?',
      body: <>Form <span className="font-medium text-foreground">{form.title}</span> sẽ bị gỡ khỏi sự kiện này.</>,
      confirmLabel: 'Gỡ form',
    }))) return;
    run('remove', () => feedbackApi.removeEventForm(eventId), 'Đã gỡ form đánh giá');
  };

  const pct = eligibleCount ? Math.round((responseCount / eligibleCount) * 100) : 0;
  const answered = eligibleCount > 0
    ? `${responseCount}/${eligibleCount} người đã check-out đã trả lời${` (${pct}%)`}`
    : 'chưa có ai check-out để trả lời';

  return (
    <Card {...cardProps}>
      {!form ? (
        canWrite ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Mẫu đánh giá" className="min-w-0 flex-1">
                {(id) => (
                  <Select
                    id={id}
                    value={templateId}
                    onChange={setTemplateId}
                    disabled={!templates?.length}
                    placeholder={templates === null ? 'Đang tải mẫu…' : templates.length ? 'Chọn mẫu đánh giá' : 'Chưa có mẫu nào'}
                    options={(templates || []).map((t) => ({ value: t.id, label: `${t.name} (${t.questions.length} câu)` }))}
                  />
                )}
              </Field>
              <div className="flex gap-2">
                <Button variant="primary" icon={FileText} loading={busy === 'attach'} disabled={!templateId} onClick={attachTemplate}>Gắn mẫu</Button>
                <Button icon={ListPlus} onClick={openEditor}>Tự soạn</Button>
              </div>
            </div>
            <Checkbox label="Ẩn danh" desc="BTC không thấy ai đã trả lời gì." checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
          </div>
        ) : (
          <p className="text-sm text-muted">Sự kiện này chưa có form đánh giá.</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {form.isOpen ? <Badge tone="success">Đang mở</Badge> : <Badge icon={Lock}>Đang đóng</Badge>}
            {form.isAnonymous && <Badge icon={EyeOff}>Ẩn danh</Badge>}
          </div>
          <p className="mt-3 text-pretty text-sm font-medium text-foreground">{form.title}</p>
          <p className="mt-1 text-pretty text-sm text-muted">
            {form.questions.length} câu hỏi
            {form.template && <> · từ mẫu “{form.template.name}”</>}
            {' · '}{answered}
          </p>
          <p className="mt-1 text-pretty text-xs text-muted">
            Người tham gia thấy form ngay sau khi quét mã QR check-out (không cần tài khoản).
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {canWrite && (form.isOpen ? (
              <Button icon={Square} loading={busy === 'open'} onClick={() => setOpen(false)}>Đóng form</Button>
            ) : (
              <Button icon={Play} loading={busy === 'open'} onClick={() => setOpen(true)}>Mở form</Button>
            ))}
            <Button icon={ChartColumn} onClick={() => setResultsOpen(true)}>Xem kết quả</Button>
            {canWrite && !locked && (
              <Dropdown align="end" ariaLabel="Thêm thao tác" trigger={<OutlineIconButton icon={Ellipsis} label="Thêm thao tác" />}>
                <MenuGroup><MenuItem icon={Pencil} onSelect={openEditor}>Sửa câu hỏi</MenuItem></MenuGroup>
                <MenuSeparator />
                <MenuGroup><MenuItem icon={Trash2} danger disabled={busy === 'remove'} onSelect={removeForm}>Gỡ form</MenuItem></MenuGroup>
              </Dropdown>
            )}
          </div>

          {canWrite && (
            <div className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-4">
              <div className="min-w-0">
                <p id={`anon-${eventId}`} className="text-sm font-medium text-foreground">Ẩn danh</p>
                <p className="mt-1 text-pretty text-sm text-muted">
                  BTC không thấy ai đã trả lời gì.{locked && form.isAnonymous ? ' Đã có người trả lời nên không thể tắt.' : ''}
                </p>
              </div>
              <Switch
                labelledBy={`anon-${eventId}`}
                checked={form.isAnonymous}
                disabled={busy === 'anon' || (locked && form.isAnonymous)}
                onChange={toggleAnonymous}
              />
            </div>
          )}
          {canWrite && locked && (
            <p className="mt-3 text-xs text-muted">Đã có người trả lời nên câu hỏi được khoá để không làm sai lệch kết quả.</p>
          )}
        </>
      )}

      {/* Soạn / sửa câu hỏi của form sự kiện */}
      <Modal
        open={!!editor}
        onClose={() => setEditor(null)}
        title={form ? 'Sửa form đánh giá' : 'Soạn form đánh giá'}
        size="lg"
        footer={(
          <>
            <Button variant="secondary" size="form" onClick={() => setEditor(null)}>Huỷ</Button>
            <Button type="submit" form="event-feedback-editor" variant="primary" size="form" loading={busy === 'save'}>Lưu form</Button>
          </>
        )}
      >
        {editor && (
          <form id="event-feedback-editor" onSubmit={saveEditor} className="flex flex-col gap-5">
            {templates?.length > 0 && (
              <Field label="Nạp câu hỏi từ mẫu">
                {(id) => (
                  <Select
                    id={id}
                    value=""
                    onChange={loadTemplateIntoEditor}
                    placeholder="Chọn mẫu để thay toàn bộ câu hỏi bên dưới"
                    options={templates.map((t) => ({ value: t.id, label: t.name }))}
                  />
                )}
              </Field>
            )}
            <Field label="Tiêu đề" required>
              {(id) => <Input id={id} maxLength={200} value={editor.title} onChange={(e) => setEditor((ed) => ({ ...ed, title: e.target.value }))} />}
            </Field>
            <Field label="Lời dẫn" optional>
              {(id) => (
                <Textarea id={id} className="resize-none" rows={2} maxLength={2000} value={editor.description}
                  onChange={(e) => setEditor((ed) => ({ ...ed, description: e.target.value }))} />
              )}
            </Field>
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-foreground">Câu hỏi</p>
              <QuestionListEditor questions={editor.questions} onChange={(questions) => setEditor((ed) => ({ ...ed, questions }))} />
            </div>
            {!form && (
              <Checkbox label="Ẩn danh" desc="BTC không thấy ai đã trả lời gì." checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            )}
          </form>
        )}
      </Modal>

      <FeedbackResultsModal open={resultsOpen} eventId={eventId} onClose={() => setResultsOpen(false)} />
    </Card>
  );
}
