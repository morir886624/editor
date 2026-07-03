import { useNoticeStore } from '../store/noticeStore';

/** Renders transient toast notices (bottom-center), newest last. */
export function NoticeHost() {
  const notices = useNoticeStore((s) => s.notices);
  const dismiss = useNoticeStore((s) => s.dismiss);

  if (notices.length === 0) return null;

  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <button
          key={n.id}
          type="button"
          className={`notice notice--${n.type}`}
          onClick={() => dismiss(n.id)}
          title="Dismiss"
        >
          {n.message}
        </button>
      ))}
    </div>
  );
}
