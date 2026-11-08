import { AnimationEvent, ReactNode, SyntheticEvent, useEffect, useId, useRef, useState } from "react";

import { useT } from "../i18n";
import { Button, ButtonTone } from "./Button";
import { cx } from "./cx";
import { IconName, IconTile } from "./Icon";

/**
 * A native modal dialog: the browser traps focus inside and gives it back on close. Escape and the
 * close button play the exit (one step faster than the entry) before it closes.
 */
function useModal(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      setClosing(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      setClosing(true);
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!closing || !dialog) return;
    if (getComputedStyle(dialog).animationName === "none") finish();
  }, [closing]);

  function finish() {
    setClosing(false);
    ref.current?.close();
    if (opener.current instanceof HTMLElement) opener.current.focus();
  }

  return {
    ref,
    closing,
    props: {
      onCancel: (event: SyntheticEvent) => {
        event.preventDefault();
        onClose();
      },
      onAnimationEnd: (event: AnimationEvent) => {
        if (closing && event.target === event.currentTarget) finish();
      },
    },
  };
}

export function Dialog({ open, onClose, title, icon, children, footer, className }: { open: boolean; onClose: () => void; title: string; icon?: IconName; children: ReactNode; footer?: ReactNode; className?: string }) {
  const { ref, closing, props } = useModal(open, onClose);
  const titleId = useId();
  const { t } = useT();
  return (
    <dialog ref={ref} className={cx("dialog", closing && "closing", className)} aria-labelledby={titleId} {...props}>
      <div className="dialog-body">
        <div className="dialog-head">
          {icon && <IconTile name={icon} size="sm" />}
          <h2 id={titleId}>{title}</h2>
          <Button tone="ghost" size="sm" icon="x" iconOnly className="dialog-close" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
        {children}
      </div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}

/**
 * The only confirm in the app. It names the step on its button, says what happens, and the
 * dangerous button is never the one that has focus first.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = "danger",
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: ButtonTone;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      icon={tone === "danger" ? "triangle-exclamation-point" : "info"}
      footer={
        <>
          <Button onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button tone={tone} busy={busy} pending={t("working")} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="dialog-text">{body}</div>
    </Dialog>
  );
}

/** A button that asks first: the confirm dialog opens, and the step runs only after "yes". */
export function ConfirmButton({
  label,
  icon,
  tone = "danger",
  size,
  title,
  body,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  icon?: IconName;
  tone?: ButtonTone;
  size?: "sm" | "md";
  title: string;
  body: ReactNode;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button tone={tone} size={size} icon={icon} disabled={disabled} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        title={title}
        body={body}
        confirmLabel={confirmLabel}
        tone={tone === "danger" ? "danger" : "primary"}
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setOpen(false);
          }
        }}
      />
    </>
  );
}

/** A panel that slides in from the left edge, for the menu on small screens. */
export function Drawer({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const { ref, closing, props } = useModal(open, onClose);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a click on the dimmed page beside the panel closes it; Escape and the close button do the same from the keyboard
    <dialog
      ref={ref}
      className={cx("drawer", closing && "closing")}
      aria-label={label}
      {...props}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
