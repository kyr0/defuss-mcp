// VERIFIED: (site e2e toggles it) Light and dark theme. The inline script in index.html applies the saved
// choice or the system preference before first paint; this module keeps the
// toggle and the system preference in sync afterwards.
const KEY = 'mcp-theme';
const media = matchMedia('(prefers-color-scheme: dark)');

export const isDark = (): boolean => document.documentElement.classList.contains('dark');

function saved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function apply(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const toggle = document.querySelector<HTMLInputElement>('#theme-toggle');
  if (toggle) toggle.checked = dark;
}

export function setTheme(dark: boolean): void {
  try {
    localStorage.setItem(KEY, dark ? 'dark' : 'light');
  } catch {
    // Private mode: the choice lasts for this page.
  }
  apply(dark);
}

export function initTheme(): void {
  const toggle = document.querySelector<HTMLInputElement>('#theme-toggle');
  if (toggle) {
    toggle.checked = isDark();
    toggle.addEventListener('change', () => setTheme(toggle.checked));
  }
  media.addEventListener('change', (event) => {
    if (!saved()) apply(event.matches);
  });
}
