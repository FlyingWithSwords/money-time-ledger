import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作用红色确认按钮，明确提醒这一步不可撤销。 */
  destructive?: boolean;
  /** 处理中禁用两个按钮，防止连点重复提交。 */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 全站统一的二次确认框，替代原生 window.confirm。
 *
 * 两个刻意的设计：
 * - 焦点默认落在「取消」上：破坏性操作不该被一个顺手的回车确认掉。
 * - busy 期间 onClose 也失效：避免异步写到一半时把弹窗关掉，用户以为取消了。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  destructive = false,
  busy = false,
  onConfirm,
  onClose,
}: Props): JSX.Element {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{message}</DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} autoFocus>
          {cancelLabel}
        </Button>
        <Button
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? '处理中…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
