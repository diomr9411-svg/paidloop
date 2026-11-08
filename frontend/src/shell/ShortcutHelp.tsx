import { Key, useT } from "../i18n";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

const ROWS: [string, Key][] = [
  ["N", "shortcutNew"],
  ["I", "shortcutInvoices"],
  ["A", "shortcutApprovals"],
  ["H", "shortcutHome"],
  ["/", "shortcutSearch"],
  ["?", "shortcutHelp"],
  ["Ctrl + Enter", "shortcutSubmit"],
];

/** The list of keyboard shortcuts, opened with "?" or from the View menu. */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("shortcuts")}
      icon="keyboard"
      footer={
        <Button tone="primary" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      <table className="shortcut-table">
        <tbody>
          {ROWS.map(([keys, label]) => (
            <tr key={keys}>
              <td className="nowrap">
                <kbd>{keys}</kbd>
              </td>
              <td>{t(label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t("shortcutsNote")}</p>
    </Dialog>
  );
}
