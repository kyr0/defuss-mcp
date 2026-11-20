// VERIFIED: (vite build, site e2e) Entry point: the design system per component, then theme, install controls
// and the demo, which loads when it first scrolls near the viewport.
// defuss-shadcn per component, not its all-in-one bundle: the page uses about
// twenty of its components.
import 'defuss-shadcn/dist/components/core.css';
import 'defuss-shadcn/dist/theme/utils/shapes.css';
import 'defuss-shadcn/dist/components/site-header/site-header.css';
import 'defuss-shadcn/dist/components/navigation-menu/navigation-menu.css';
import 'defuss-shadcn/dist/components/button/button.css';
import 'defuss-shadcn/dist/components/badge/badge.css';
import 'defuss-shadcn/dist/components/toggle-group/toggle-group.css';
import 'defuss-shadcn/dist/components/toggle/toggle.css';
import 'defuss-shadcn/dist/components/swap/swap.css';
import 'defuss-shadcn/dist/components/sheet/sheet.css';
import 'defuss-shadcn/dist/components/hero/hero.css';
import 'defuss-shadcn/dist/components/parallax/parallax.css';
import 'defuss-shadcn/dist/components/heading-anchor/heading-anchor.css';
import 'defuss-shadcn/dist/components/mockup-code/mockup-code.css';
import 'defuss-shadcn/dist/components/tabs/tabs.css';
import 'defuss-shadcn/dist/components/label/label.css';
import 'defuss-shadcn/dist/components/textarea/textarea.css';
import 'defuss-shadcn/dist/components/card/card.css';
import 'defuss-shadcn/dist/components/table/table.css';
import 'defuss-shadcn/dist/components/diagram/diagram.css';
import 'defuss-shadcn/dist/components/section-header/section-header.css';
import 'defuss-shadcn/dist/components/cta/cta.css';
import 'defuss-shadcn/dist/components/site-footer/site-footer.css';
import 'defuss-shadcn/dist/components/separator/separator.css';
import 'defuss-shadcn/dist/components/empty-state/empty-state.css';
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles.css';
import 'defuss-shadcn/dist/components/core.js';
import 'defuss-shadcn/dist/components/toggle/toggle.js';
import 'defuss-shadcn/dist/components/toggle-group/toggle-group.js';
import 'defuss-shadcn/dist/components/sheet/sheet.js';
import 'defuss-shadcn/dist/components/tabs/tabs.js';
import 'defuss-shadcn/dist/components/diagram/diagram.js';
import { initInstall } from './install.ts';
import { initTheme } from './theme.ts';

/** Run start once element is within margin of the viewport. */
function whenVisible(element: Element | null, start: () => void, margin = '400px 0px'): void {
  if (!element) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      start();
    },
    { rootMargin: margin },
  );
  observer.observe(element);
}

function main(): void {
  initTheme();
  initInstall();
  const demo = document.querySelector<HTMLElement>('[data-demo]');
  whenVisible(demo, () => void import('./demo.ts').then((module) => module.initDemo(demo!)));
  document.documentElement.dataset.ready = '';
}

main();
