import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Splitter({ onDrag }: { onDrag: (deltaY: number) => void }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    let last = e.clientY;
    const move = (ev: PointerEvent) => {
      onDrag(ev.clientY - last);
      last = ev.clientY;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="splitter" role="separator" aria-orientation="horizontal" onPointerDown={start} />;
}

export interface MenuEntry {
  label: string;
  onSelect?: () => void;
  separatorBefore?: boolean;
  /** Entries of a submenu opened to the right. */
  children?: MenuEntry[];
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const [sub, setSub] = useState<string | null>(null);
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16);
  return (
    <div className="menu" ref={ref} style={{ left, top }} role="menu">
      {items.map((item) => (
        <div key={item.label} className="menu-item" onMouseEnter={() => setSub(item.children ? item.label : null)}>
          {item.separatorBefore && <hr />}
          <button
            role="menuitem"
            aria-haspopup={item.children ? 'menu' : undefined}
            onClick={() => {
              if (item.children) {
                setSub(item.label);
                return;
              }
              onClose();
              item.onSelect?.();
            }}
          >
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.children && <span aria-hidden="true">›</span>}
          </button>
          {item.children && sub === item.label && (
            <div className="menu submenu" role="menu" aria-label={item.label}>
              {item.children.map((child) => (
                <button
                  key={child.label}
                  role="menuitem"
                  onClick={() => {
                    onClose();
                    child.onSelect?.();
                  }}
                >
                  {child.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Open dialogs, oldest first. */
const openModals: object[] = [];

export function Modal({
  title,
  onClose,
  children,
  footer,
  className = '',
  align,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  align?: 'center';
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // registered once per dialog, so the order of the stack is the order the dialogs opened
    const token = {};
    openModals.push(token);
    const onKey = (e: KeyboardEvent) => {
      // Esc closes only the topmost dialog (a name prompt over the Cadastro, a credential over the form)
      if (e.key === 'Escape' && openModals[openModals.length - 1] === token) {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      openModals.splice(openModals.indexOf(token), 1);
    };
  }, []);
  return (
    <div
      className="overlay"
      style={align === 'center' ? { alignItems: 'center', paddingTop: 0 } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        {children}
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function DialogHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="dialog-head">
      <h2>{title}</h2>
      {right}
    </div>
  );
}
