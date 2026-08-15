/**
 * Desktop composer attachments — Codex-style path chips.
 *
 * The harness composer only intakes images. In the desktop shell we:
 *   - turn the "+" into a menu (命令 / 上传图片 / 上传附件)
 *   - accept pasted or dropped non-image files
 *   - show them in a rail above the draft, like images
 *   - on send, prepend the source file paths so the agent can read them
 *
 * Images keep the existing harness pipeline (multimodal / vision).
 */

const IMAGE_TYPE = /^image\/(png|jpeg|jpg|webp|gif)$/i

/** Inject the composer attachment overlay into the harness page. */
export async function injectComposerAttach(webContents) {
  if (webContents === undefined || webContents.isDestroyed()) return
  await webContents.executeJavaScript(`(() => {
    if (window.__dshComposerAttach) return;
    window.__dshComposerAttach = true;

    const IMAGE_TYPE = ${IMAGE_TYPE};
    const files = [];
    let menu = null;
    let rail = null;
    let style = null;
    let imageInput = null;
    let passCommand = false;

    const api = window.dshDesktop;
    const pathOf = (file) => {
      try {
        if (api && typeof api.getPathForFile === 'function') {
          const value = api.getPathForFile(file);
          if (typeof value === 'string' && value.trim() !== '') return value;
        }
      } catch { /* renderer helper may be absent in a stale preload */ }
      if (typeof file.path === 'string' && file.path.trim() !== '') return file.path;
      return '';
    };

    const basename = (p) => {
      const norm = String(p).replace(/\\\\/g, '/');
      const i = norm.lastIndexOf('/');
      return i >= 0 ? norm.slice(i + 1) : norm;
    };

    const extOf = (p) => {
      const name = basename(p);
      const i = name.lastIndexOf('.');
      return i >= 0 ? name.slice(i + 1).toUpperCase() : 'FILE';
    };

    const ensureStyle = () => {
      if (style !== null) return;
      style = document.createElement('style');
      style.textContent = \`
        #dsh-file-rail { display:flex; gap:8px; overflow-x:auto; padding:0 16px 4px; scrollbar-width:thin; }
        #dsh-file-rail:empty { display:none; }
        .dsh-file-chip { position:relative; flex:none; display:flex; align-items:center; gap:8px;
          max-width:220px; padding:8px 28px 8px 10px; border-radius:12px;
          background:var(--dsw-specific-selector, rgba(127,140,160,.14));
          color:var(--dsw-alias-label-primary, inherit); font-size:12px; line-height:16px; }
        .dsh-file-chip__ext { flex:none; min-width:34px; padding:2px 4px; border-radius:6px;
          background:rgba(77,107,254,.22); color:#8fb3ff; font-weight:700; font-size:10px;
          letter-spacing:.04em; text-align:center; }
        html.dsh-light .dsh-file-chip__ext { color:#3b56c9; }
        .dsh-file-chip__meta { min-width:0; }
        .dsh-file-chip__name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
        .dsh-file-chip__path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          color:var(--dsw-alias-label-caption, #81858c); font-size:11px; }
        .dsh-file-chip__x { position:absolute; top:4px; right:4px; width:18px; height:18px; border:0;
          border-radius:999px; background:transparent; color:inherit; cursor:pointer; opacity:.7; }
        .dsh-file-chip__x:hover { background:rgba(0,0,0,.12); opacity:1; }
        #dsh-plus-menu { position:fixed; z-index:2147483645; min-width:168px; padding:6px;
          border-radius:12px; background:#1b2333; border:1px solid rgba(255,255,255,.1);
          box-shadow:0 14px 40px rgba(0,0,0,.4); color:#eef3ff;
          font:13px/1.4 "Segoe UI","Microsoft YaHei",sans-serif; }
        html.dsh-light #dsh-plus-menu { background:#fff; color:#17212b; border-color:rgba(23,33,43,.12);
          box-shadow:0 14px 40px rgba(23,33,43,.16); }
        #dsh-plus-menu button { display:flex; align-items:center; gap:8px; width:100%; padding:8px 10px;
          border:0; border-radius:8px; background:transparent; color:inherit; text-align:left; cursor:pointer; }
        #dsh-plus-menu button:hover { background:rgba(77,107,254,.16); }
      \`;
      document.head.appendChild(style);
    };

    const card = () => document.querySelector('[data-composer-card]');
    const plusButton = () => card()?.querySelector('button[aria-haspopup="listbox"]') ?? null;
    const textarea = () => card()?.querySelector('textarea') ?? null;

    const mountRail = () => {
      const host = card();
      if (host === null) return;
      if (rail !== null && host.contains(rail)) return;
      ensureStyle();
      rail = document.createElement('div');
      rail.id = 'dsh-file-rail';
      const scroll = host.querySelector('[data-input-scroll]');
      if (scroll !== null) host.insertBefore(rail, scroll);
      else host.prepend(rail);
      renderRail();
    };

    const renderRail = () => {
      if (rail === null) return;
      rail.replaceChildren();
      for (const item of files) {
        const chip = document.createElement('div');
        chip.className = 'dsh-file-chip';
        chip.title = item.path;
        chip.innerHTML =
          '<span class="dsh-file-chip__ext"></span>'
          + '<span class="dsh-file-chip__meta"><div class="dsh-file-chip__name"></div>'
          + '<div class="dsh-file-chip__path"></div></span>'
          + '<button type="button" class="dsh-file-chip__x" aria-label="移除附件">×</button>';
        chip.querySelector('.dsh-file-chip__ext').textContent = extOf(item.path);
        chip.querySelector('.dsh-file-chip__name').textContent = item.name;
        chip.querySelector('.dsh-file-chip__path').textContent = item.path;
        chip.querySelector('.dsh-file-chip__x').addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const idx = files.findIndex((f) => f.id === item.id);
          if (idx >= 0) files.splice(idx, 1);
          renderRail();
        });
        rail.appendChild(chip);
      }
    };

    const addPaths = (paths) => {
      let added = 0;
      for (const raw of paths) {
        const path = String(raw ?? '').trim();
        if (path === '') continue;
        if (files.some((f) => f.path.toLowerCase() === path.toLowerCase())) continue;
        files.push({ id: String(Date.now()) + '-' + String(files.length), path, name: basename(path) });
        added += 1;
      }
      if (added > 0) {
        mountRail();
        renderRail();
        const el = textarea();
        if (el !== null && el.value.trim() === '') setDraft(' ');
      }
      return added;
    };

    const addFromFileList = (list) => {
      const images = [];
      const paths = [];
      for (const file of list) {
        if (file === null) continue;
        if (IMAGE_TYPE.test(file.type || '')) images.push(file);
        else {
          const path = pathOf(file);
          if (path !== '') paths.push(path);
        }
      }
      addPaths(paths);
      return images;
    };

    const dispatchImages = (images) => {
      if (images.length === 0) return;
      const dt = new DataTransfer();
      for (const file of images) dt.items.add(file);
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    };

    const setDraft = (value) => {
      const el = textarea();
      if (el === null) return false;
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      proto.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const consumePathsIntoDraft = () => {
      if (files.length === 0) return false;
      const paths = files.map((f) => f.path);
      const block = paths.length === 1
        ? '请查看附件（源文件路径）：' + paths[0]
        : '请查看以下附件（源文件路径，请直接读取）：\\n' + paths.map((p) => '- ' + p).join('\\n');
      const el = textarea();
      const current = el?.value ?? '';
      const next = current.trim() === '' ? block : block + '\\n\\n' + current;
      files.splice(0, files.length);
      renderRail();
      return setDraft(next);
    };

    const hideMenu = () => {
      menu?.remove();
      menu = null;
    };

    const showMenu = (anchor) => {
      ensureStyle();
      hideMenu();
      menu = document.createElement('div');
      menu.id = 'dsh-plus-menu';
      menu.innerHTML =
        '<button type="button" data-act="command">／ 命令</button>'
        + '<button type="button" data-act="image">🖼 上传图片</button>'
        + '<button type="button" data-act="file">📎 上传附件</button>';
      document.body.appendChild(menu);
      const rect = anchor.getBoundingClientRect();
      const top = rect.top - menu.offsetHeight - 8;
      menu.style.left = Math.max(8, rect.left) + 'px';
      menu.style.top = (top < 50 ? rect.bottom + 8 : top) + 'px';
      menu.addEventListener('click', async (event) => {
        const act = event.target.closest('button')?.dataset.act;
        hideMenu();
        if (act === 'command') {
          passCommand = true;
          anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } else if (act === 'image') {
          ensureImageInput();
          imageInput.click();
        } else if (act === 'file' && api && typeof api.pickFiles === 'function') {
          try {
            const picked = await api.pickFiles({ images: false });
            if (Array.isArray(picked)) addPaths(picked);
          } catch { /* user cancelled or dialog failed */ }
        }
      });
    };

    const ensureImageInput = () => {
      if (imageInput !== null) return;
      imageInput = document.createElement('input');
      imageInput.type = 'file';
      imageInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
      imageInput.multiple = true;
      imageInput.hidden = true;
      document.body.appendChild(imageInput);
      imageInput.addEventListener('change', () => {
        const images = [...(imageInput.files ?? [])];
        imageInput.value = '';
        dispatchImages(images);
      });
    };

    document.addEventListener('click', (event) => {
      const plus = plusButton();
      if (plus !== null && plus.contains(event.target)) {
        if (passCommand) { passCommand = false; return; }
        if (menu !== null) { hideMenu(); event.preventDefault(); event.stopPropagation(); return; }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        showMenu(plus);
        return;
      }
      if (menu !== null && !menu.contains(event.target)) hideMenu();
    }, true);

    document.addEventListener('paste', (event) => {
      const items = [...(event.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file) => file !== null);
      if (items.length === 0) return;
      const images = addFromFileList(items);
      const hadNonImage = items.some((file) => !IMAGE_TYPE.test(file.type || ''));
      if (!hadNonImage) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchImages(images);
    }, true);

    document.addEventListener('drop', (event) => {
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (dropped.length === 0) return;
      const hadNonImage = dropped.some((file) => !IMAGE_TYPE.test(file.type || ''));
      if (!hadNonImage) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchImages(addFromFileList(dropped));
    }, true);

    document.addEventListener('click', (event) => {
      const send = event.target.closest('[data-composer-card] button[aria-label="发送消息"], [data-composer-card] button[aria-label="Send message"]');
      if (send === null || files.length === 0) return;
      consumePathsIntoDraft();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if (files.length === 0) return;
      if (event.target !== textarea()) return;
      consumePathsIntoDraft();
    }, true);

    const mo = new MutationObserver(() => { if (files.length > 0) mountRail(); });
    mo.observe(document.body, { childList: true, subtree: true });
    mountRail();
  })()`)
}
