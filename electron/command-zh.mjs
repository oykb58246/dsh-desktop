/**
 * Translate slash-command descriptions when the UI is Chinese.
 * Rewrites existing listboxes as their rows appear (menu often mounts empty).
 */

const BY_NAME = {
  compact: '压缩较早的对话历史，腾出上下文空间',
  export: '把本会话记录打包成 ZIP 下载',
  feedback: '为本会话写下反馈',
  goal: '设置或查看长期任务的目标',
  permission: '切换权限预设（沙箱模式 + 审批策略）',
  plan: '进入或退出计划模式',
  model: '选择本会话使用的模型',
}

/** Inject a translator for the slash / plus command menu. */
export async function injectCommandZh(webContents) {
  if (webContents === undefined || webContents.isDestroyed()) return
  await webContents.executeJavaScript(`(() => {
    if (window.__dshCommandZh) return;
    window.__dshCommandZh = true;
    const BY_NAME = ${JSON.stringify(BY_NAME)};
    const rewrite = () => {
      for (const box of document.querySelectorAll('[role="listbox"]')) {
        for (const option of box.querySelectorAll('[role="option"]')) {
          const spans = [...option.querySelectorAll('span')];
          let name = '';
          for (const span of spans) {
            const text = span.textContent.trim();
            if (Object.prototype.hasOwnProperty.call(BY_NAME, text)) { name = text; break; }
          }
          if (name === '') {
            const raw = option.textContent.trim();
            name = Object.keys(BY_NAME).find((key) => raw === key || raw.startsWith(key + ' ') || raw.startsWith(key + '\\t')) || '';
          }
          if (name === '') continue;
          const zh = BY_NAME[name];
          const descSpan = spans[spans.length - 1];
          const nameSpan = spans.find((span) => span.textContent.trim() === name);
          if (descSpan && descSpan !== nameSpan) {
            if (descSpan.textContent !== zh) descSpan.textContent = zh;
          } else if (nameSpan) {
            let extra = nameSpan.nextElementSibling;
            if (extra === null) {
              extra = document.createElement('span');
              nameSpan.parentNode.appendChild(extra);
            }
            extra.textContent = zh;
          }
        }
      }
    };
    let timer = 0;
    const schedule = () => {
      if (timer !== 0) return;
      timer = window.setTimeout(() => { timer = 0; rewrite(); }, 40);
    };
    rewrite();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keyup', (event) => {
      if (event.key === '/' || event.key === 'Process') schedule();
    }, true);
  })()`)
}
