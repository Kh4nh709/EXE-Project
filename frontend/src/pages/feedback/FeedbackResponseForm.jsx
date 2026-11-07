import { useState, useEffect } from 'react';
import { CircleCheck, EyeOff } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { feedbackApi } from '../../services/api';
import Button from '../../components/ui/Button';
import StarRating from '../../components/ui/StarRating';
import { Textarea } from '../../components/ui/Input';
import { Banner, Skeleton } from '../../components/ui/States';
import { cx } from '../../utils/cx';

// Form trả lời đánh giá, dùng ở 2 nơi: trang /feedback/:eventId và ngay dưới
// thẻ "Check-out thành công" của trang quét mã (showTitle — trang đó không có
// header riêng). onLoaded(data) cho trang cha lấy tiêu đề/tên sự kiện.
// checkinPass: người check-in bằng OTP không đăng nhập — gọi API bằng thẻ điểm danh.
export default function FeedbackResponseForm({ eventId, showTitle = false, onLoaded, checkinPass }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [justSent, setJustSent] = useState(false);

  useEffect(() => {
    const load = checkinPass
      ? feedbackApi.getMyResponseWithPass(eventId, checkinPass)
      : feedbackApi.getMyResponse(eventId);
    load
      .then(({ data: res }) => {
        setData(res.data);
        setAnswers(res.data.myResponse?.answers || {});
        onLoaded?.(res.data);
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Không tải được form đánh giá'));
  }, [eventId, checkinPass]); // eslint-disable-line

  const box = cx('rounded-2xl bg-surface', showTitle ? 'p-5' : 'border border-border p-4 sm:p-5');

  if (loadError) {
    return <div className={cx(box, 'text-center')}><p className="text-pretty py-4 text-sm text-muted">{loadError}</p></div>;
  }
  if (!data) {
    return (
      <div className={cx(box, 'space-y-4')} aria-busy="true">
        <Skeleton className="h-4 w-2/3" /><Skeleton className="h-10 w-1/2 rounded-xl" /><Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  const setAnswer = (id, value) => setAnswers((a) => ({ ...a, [id]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const missing = data.form.questions.findIndex((q) => q.required && (
      q.type === 'RATING' ? !answers[q.id] : !String(answers[q.id] || '').trim()
    ));
    if (missing >= 0) {
      document.getElementById(`q-${data.form.questions[missing].id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return toast.error(`Câu ${missing + 1} là câu bắt buộc`);
    }

    setSubmitting(true);
    try {
      const { data: res } = checkinPass
        ? await feedbackApi.submitWithPass(eventId, answers, checkinPass)
        : await feedbackApi.submit(eventId, answers);
      toast.success(res.message);
      setData((d) => ({ ...d, myResponse: res.data }));
      setJustSent(true);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Gửi đánh giá thất bại');
    } finally {
      setSubmitting(false);
    }
  };

  // Vừa gửi xong: thu gọn thành lời cảm ơn thay vì để nguyên form dài.
  if (justSent) {
    return (
      <div className="flex gap-3 rounded-2xl bg-success-bg p-4 text-left">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-success">Cảm ơn bạn đã gửi đánh giá!</p>
          <p className="mt-0.5 text-pretty text-sm text-foreground/80">Bạn vẫn có thể sửa câu trả lời khi form còn mở.</p>
          <button type="button" onClick={() => setJustSent(false)} className="mt-2 text-sm font-medium text-foreground underline underline-offset-4 outline-none">
            Xem / sửa câu trả lời
          </button>
        </div>
      </div>
    );
  }

  const questions = data.form.questions.map((q, i) => (
    <fieldset key={q.id} id={`q-${q.id}`} className="flex flex-col gap-3 border-t border-border pt-5 first:border-0 first:pt-0">
      <legend className="text-pretty text-sm font-medium text-foreground">
        {i + 1}. {q.label}
        {q.required && <span aria-hidden="true" className="text-error-text"> *</span>}
      </legend>
      {q.type === 'RATING' ? (
        <StarRating
          value={answers[q.id] || 0}
          onChange={data.canSubmit ? (v) => setAnswer(q.id, v) : undefined}
          size={28}
        />
      ) : (
        <Textarea
          rows={3}
          maxLength={2000}
          className="resize-y"
          aria-label={q.label}
          disabled={!data.canSubmit}
          placeholder="Nhập câu trả lời của bạn..."
          value={answers[q.id] || ''}
          onChange={(e) => setAnswer(q.id, e.target.value)}
        />
      )}
    </fieldset>
  ));

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 text-left">
      {data.myResponse && (
        <Banner tone="info" compact>
          Bạn đã gửi đánh giá lúc {format(new Date(data.myResponse.updatedAt), 'HH:mm dd/MM/yyyy')}.
          {data.canSubmit && ' Bạn có thể sửa và gửi lại.'}
        </Banner>
      )}
      {!data.canSubmit && <Banner tone="warning" compact>{data.reasonMessage}</Banner>}

      <section className={box}>
        {showTitle && (
          <div className="mb-5">
            <h2 className="text-base font-semibold text-foreground">Đánh giá sự kiện</h2>
            <p className="mt-1 text-pretty text-sm text-muted">{data.form.title}</p>
          </div>
        )}
        {data.form.description && (
          <p className="mb-5 whitespace-pre-line text-pretty text-sm text-muted">{data.form.description}</p>
        )}
        {data.form.isAnonymous && (
          <p className="mb-5 flex gap-2 text-pretty text-sm text-muted">
            <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Form ẩn danh: Ban tổ chức không biết ai đã trả lời gì.
          </p>
        )}
        <div className="flex flex-col gap-5">{questions}</div>
        {showTitle && data.canSubmit && (
          <div className="mt-5">
            <Button type="submit" variant="primary" size="auth" loading={submitting} className="w-full">
              {data.myResponse ? 'Cập nhật đánh giá' : 'Gửi đánh giá'}
            </Button>
          </div>
        )}
      </section>

      {!showTitle && data.canSubmit && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="form" loading={submitting} className="w-full sm:w-auto">
            {data.myResponse ? 'Cập nhật đánh giá' : 'Gửi đánh giá'}
          </Button>
        </div>
      )}
    </form>
  );
}
