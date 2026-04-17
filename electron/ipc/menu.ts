/**
 * IPC handler for showing styled popup context menus.
 *
 * Uses a child BrowserWindow (separate OS window) to render the menu.
 * This renders above everything — including native WebContentsViews —
 * while allowing full CSS styling to match the app theme.
 */

import { ipcMain, BrowserWindow, screen } from 'electron';
import { AppState } from '../services/state.js';

interface PopupMenuItem {
  id: string;
  label: string;
  type?: 'separator' | 'header';
  variant?: 'danger';
  icon?: string; // key into SVG icon map
  children?: PopupMenuItem[]; // submenu items
}

// Inline SVG icons (Tabler Icons, 24x24 viewBox, stroke-based)
// Each value is just the inner <path>/<circle>/etc elements.
const iconPaths: Record<string, string> = {
  play: '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>',
  edit: '<path d="M7 7h-1a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1"/><path d="M20.385 6.585a2.1 2.1 0 0 0-2.97-2.97l-8.415 8.385v3h3l8.385-8.415z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8v-2a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  'copy-host': '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><line x1="3" y1="6" x2="3" y2="19"/><line x1="12" y1="6" x2="12" y2="19"/><line x1="21" y1="6" x2="21" y2="19"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>',
  key: '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1-4.069 0l-3.602-3.602a4 4 0 0 1-1.843.357 4 4 0 1 1 3.357-1.843z"/><path d="M14.5 7.5l4 4"/>',
  star: '<path d="M12 17.75l-6.172 3.245l1.179-6.873l-5-4.867l6.9-1l3.086-6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/>',
  'star-off': '<path d="M12 17.75l-6.172 3.245l1.179-6.873l-5-4.867l6.9-1l3.086-6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/><line x1="3" y1="3" x2="21" y2="21"/>',
  rename: '<path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7v-2a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/>',
  trash: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  'folder-plus': '<path d="M12 19h-7a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v3"/><line x1="16" y1="19" x2="22" y2="19"/><line x1="19" y1="16" x2="19" y2="22"/>',
  folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  reconnect: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  home: '<path d="M5 12l-2 0l9-9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/><path d="M9 21v-6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6"/>',
  terminal: '<path d="M5 7l5 5l-5 5"/><line x1="12" y1="19" x2="19" y2="19"/>',
  shield: '<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1-8.5 15a12 12 0 0 1-8.5-15a12 12 0 0 0 8.5-3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><circle cx="12" cy="16" r="1"/><path d="M8 11v-4a4 4 0 0 1 8 0v4"/>',
  'external-link': '<path d="M11 7h-5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-5"/><line x1="10" y1="14" x2="20" y2="4"/><polyline points="15 4 20 4 20 9"/>',
  'dots': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  'chevron-right': '<polyline points="9 6 15 12 9 18"/>',
  'keyboard': '<path d="M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-16a2 2 0 0 1-2-2z"/><line x1="6" y1="10" x2="6" y2="10.01"/><line x1="10" y1="10" x2="10" y2="10.01"/><line x1="14" y1="10" x2="14" y2="10.01"/><line x1="18" y1="10" x2="18" y2="10.01"/><line x1="6" y1="14" x2="6" y2="14.01"/><line x1="18" y1="14" x2="18" y2="14.01"/><line x1="10" y1="14" x2="14" y2="14"/>',
  'connect': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'clock': '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>',
};

function svgIcon(name: string, color: string): string {
  const paths = iconPaths[name];
  if (!paths) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">${paths}</svg>`;
}

// Theme color definitions matching src/index.css
const themes = {
  light: {
    panel: '#ffffff',
    raised: '#e2e8f0',
    ink: '#0f172a',
    inkFaint: '#94a3b8',
    strokeDim: '#e2e8f0',
    danger: '#f87171',
    dangerHover: 'rgba(248,113,113,0.12)',
    shadow: 'rgba(0,0,0,0.12)',
  },
  dark: {
    panel: '#1e293b',
    raised: '#334155',
    ink: '#f1f5f9',
    inkFaint: '#64748b',
    strokeDim: '#475569',
    danger: '#f87171',
    dangerHover: 'rgba(248,113,113,0.15)',
    shadow: 'rgba(0,0,0,0.45)',
  },
};

export function registerMenuHandlers(): void {
  ipcMain.handle(
    'show_context_menu_popup',
    async (
      _e,
      args: {
        items: PopupMenuItem[];
        x: number;
        y: number;
        theme?: string;
        colors?: { panel?: string; raised?: string; ink?: string; inkFaint?: string; strokeDim?: string };
        anchorRight?: boolean;
      }
    ): Promise<string | null> => {
      const parentWindow = AppState.getInstance().getMainWindow();
      if (!parentWindow) return null;

      const fallback = args.theme === 'light' ? themes.light : themes.dark;
      const t = {
        panel: args.colors?.panel || fallback.panel,
        raised: args.colors?.raised || fallback.raised,
        ink: args.colors?.ink || fallback.ink,
        inkFaint: args.colors?.inkFaint || fallback.inkFaint,
        strokeDim: args.colors?.strokeDim || fallback.strokeDim,
        danger: fallback.danger,
        dangerHover: fallback.dangerHover,
        shadow: fallback.shadow,
      };

      // Calculate dimensions
      const menuWidth = 210;
      const itemH = 30;
      const sepH = 9;
      const headerH = 24;
      const pad = 4;
      // Border (2px) + padding + extra buffer for shadow/border-radius
      const border = 2;
      const buffer = 12;

      const calcHeight = (items: PopupMenuItem[]) => {
        let h = pad * 2 + border + buffer;
        for (const item of items) {
          h += item.type === 'separator' ? sepH : item.type === 'header' ? headerH : itemH;
        }
        return h;
      };

      const hasSubmenus = args.items.some((i) => i.children?.length);
      let menuHeight = calcHeight(args.items);

      // If submenus exist, compute max submenu height for window sizing
      let maxSubmenuHeight = 0;
      if (hasSubmenus) {
        for (const item of args.items) {
          if (item.children?.length) {
            maxSubmenuHeight = Math.max(maxSubmenuHeight, calcHeight(item.children));
          }
        }
      }

      // Convert x/y from CSS pixels to screen coords (account for content area position + scale).
      // Use getContentBounds() not getBounds() — getBounds() includes the title bar,
      // which offsets the menu above the actual click position.
      const contentBounds = parentWindow.getContentBounds();
      const scale = parentWindow.webContents.getZoomFactor();
      let x = Math.round(contentBounds.x + args.x * scale);
      let y = Math.round(contentBounds.y + args.y * scale);

      // Anchor menu from the right edge of the given x position
      if (args.anchorRight) {
        x = x - menuWidth;
      }

      // Keep on screen
      const display = screen.getDisplayNearestPoint({ x, y });
      const db = display.workArea;
      if (x + menuWidth > db.x + db.width) x = x - menuWidth;
      if (x < db.x) x = db.x;
      if (y + menuHeight > db.y + db.height) y = y - menuHeight;

      return new Promise<string | null>((resolve) => {
        let resolved = false;
        const done = (id: string | null) => {
          if (resolved) return;
          resolved = true;
          if (!popup.isDestroyed()) popup.close();
          resolve(id);
        };

        // Window must be large enough for main menu + submenu side by side
        const windowWidth = hasSubmenus ? menuWidth * 2 + 4 : menuWidth;
        const windowHeight = hasSubmenus ? Math.max(menuHeight, maxSubmenuHeight + itemH) : menuHeight;

        const popup = new BrowserWindow({
          parent: parentWindow,
          x,
          y,
          width: windowWidth,
          height: windowHeight,
          frame: false,
          transparent: true,
          skipTaskbar: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          hasShadow: false,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        popup.on('blur', () => done(null));
        popup.on('closed', () => done(null));

        // Listen for item selection via console messages (no preload needed)
        popup.webContents.on('console-message', (ev) => {
          if (ev.message.startsWith('__MENU__:')) {
            done(ev.message.slice(9));
          }
        });

        // Build menu HTML
        const renderItem = (item: PopupMenuItem): string => {
          if (item.type === 'separator') {
            return `<div style="height:1px;margin:4px 8px;background:${t.strokeDim}"></div>`;
          }
          if (item.type === 'header') {
            return `<div style="padding:4px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:${t.inkFaint};user-select:none;-webkit-user-select:none">${item.label}</div>`;
          }
          const color = item.variant === 'danger' ? t.danger : t.ink;
          const iconColor = item.variant === 'danger' ? t.danger : t.inkFaint;
          const hoverBg = item.variant === 'danger' ? t.dangerHover : t.raised;
          const iconHtml = item.icon ? svgIcon(item.icon, iconColor) : '';

          if (item.children?.length) {
            const chevron = svgIcon('chevron-right', t.inkFaint);
            return `<div class="i" style="color:${color}" data-hover="${hoverBg}" data-submenu="${item.id}"
              >${iconHtml}<span style="flex:1">${item.label}</span>${chevron}</div>`;
          }

          return `<div class="i" style="color:${color}" data-hover="${hoverBg}"
            onmouseenter="this.style.background=this.dataset.hover"
            onmouseleave="this.style.background='transparent'"
            onmousedown="console.log('__MENU__:${item.id}')"
            >${iconHtml}<span>${item.label}</span></div>`;
        };

        const itemsHtml = args.items.map(renderItem).join('');

        // Build submenu panels
        let submenusHtml = '';
        for (const item of args.items) {
          if (!item.children?.length) continue;
          const subItems = item.children.map(renderItem).join('');
          submenusHtml += `<div class="sm" data-for="${item.id}">${subItems}</div>`;
        }

        const submenuJs = hasSubmenus ? `
(function(){
  var timer=null;
  var activeSub=null;
  document.querySelectorAll('[data-submenu]').forEach(function(el){
    el.addEventListener('mouseenter',function(){
      if(timer){clearTimeout(timer);timer=null}
      el.style.background=el.dataset.hover;
      var id=el.dataset.submenu;
      if(activeSub&&activeSub.dataset.for!==id){activeSub.style.display='none'}
      var sm=document.querySelector('.sm[data-for="'+id+'"]');
      if(sm){
        var rect=el.getBoundingClientRect();
        sm.style.top=rect.top+'px';
        sm.style.left=(${menuWidth}-2)+'px';
        sm.style.display='block';
        activeSub=sm;
      }
    });
    el.addEventListener('mouseleave',function(e){
      var sm=activeSub;
      timer=setTimeout(function(){
        el.style.background='transparent';
        if(sm&&sm===activeSub){sm.style.display='none';activeSub=null}
      },100);
    });
  });
  document.querySelectorAll('.sm').forEach(function(sm){
    sm.addEventListener('mouseenter',function(){if(timer){clearTimeout(timer);timer=null}
      var forId=sm.dataset.for;
      var parent=document.querySelector('[data-submenu="'+forId+'"]');
      if(parent)parent.style.background=parent.dataset.hover;
    });
    sm.addEventListener('mouseleave',function(){
      sm.style.display='none';activeSub=null;
      var forId=sm.dataset.for;
      var parent=document.querySelector('[data-submenu="'+forId+'"]');
      if(parent)parent.style.background='transparent';
    });
  });
})();` : '';

        const html = `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box${process.platform === 'darwin' ? ';-electron-corner-smoothing:system-ui' : ''}}
html,body{background:transparent;overflow:hidden}
.m{background:${t.panel};border:1px solid ${t.strokeDim};border-radius:8px;
padding:${pad}px 0;box-shadow:0 4px 24px ${t.shadow};overflow:hidden;
font-family:Inter,system-ui,-apple-system,sans-serif}
.i{padding:5px 12px;font-size:13px;cursor:default;border-radius:4px;margin:0 4px;
user-select:none;-webkit-user-select:none;line-height:20px;
display:flex;align-items:center;gap:8px}
.sm{position:absolute;display:none;background:${t.panel};border:1px solid ${t.strokeDim};
border-radius:8px;padding:${pad}px 0;box-shadow:0 4px 24px ${t.shadow};overflow:hidden;
width:${menuWidth}px;font-family:Inter,system-ui,-apple-system,sans-serif}
</style></head><body>
<div class="m" style="width:${menuWidth}px">${itemsHtml}</div>
${submenusHtml}
<script>
document.addEventListener('keydown',e=>{if(e.key==='Escape')console.log('__MENU__:')});
${submenuJs}
</script>
</body></html>`;

        popup.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
        );

        popup.webContents.on('did-finish-load', () => {
          if (!popup.isDestroyed()) popup.show();
        });
      });
    }
  );
}
