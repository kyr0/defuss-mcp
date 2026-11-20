// VERIFIED: (site e2e) The package-manager switch and the copy buttons.
async function copy(text: string, button: HTMLElement): Promise<void> {
  const label = button.querySelector('span');
  const before = label?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    if (label) label.textContent = 'Copied';
  } catch {
    if (label) label.textContent = 'Select and copy';
  }
  setTimeout(() => {
    if (label) label.textContent = before;
  }, 1600);
}

const lineText = (root: Element) => [...root.querySelectorAll('pre code')].map((code) => code.textContent ?? '').join('\n');

export function initInstall(): void {
  for (const box of document.querySelectorAll<HTMLElement>('[data-install]')) {
    const windows = [...box.querySelectorAll<HTMLElement>('[data-pm]')];
    box.querySelector('.toggle-group')?.addEventListener('click', (event) => {
      const toggle = (event.target as Element).closest<HTMLButtonElement>('.toggle');
      if (!toggle) return;
      for (const item of box.querySelectorAll<HTMLButtonElement>('.toggle')) item.setAttribute('aria-pressed', String(item === toggle));
      for (const window of windows) window.hidden = window.dataset.pm !== toggle.value;
    });
    const button = box.querySelector<HTMLElement>('[data-copy-install]');
    button?.addEventListener('click', () => {
      const visible = windows.find((window) => !window.hidden);
      if (visible) void copy(lineText(visible), button);
    });
  }
  const prompt = document.querySelector<HTMLElement>('[data-prompt]');
  const promptButton = document.querySelector<HTMLElement>('[data-copy-prompt]');
  if (prompt && promptButton) promptButton.addEventListener('click', () => void copy(lineText(prompt), promptButton));
}
