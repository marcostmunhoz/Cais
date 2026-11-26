/** Puts text on the clipboard. The async API needs a focused document; falls back to execCommand when it refuses. */
export function writeClipboard(text: string): void {
  const fallback = () => {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  };
  navigator.clipboard.writeText(text).catch(fallback);
}
