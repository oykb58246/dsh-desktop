/**
 * After a turn settles, fold the round's process rows into one bar:
 *
 *   ▸ 本轮用时 4秒（点击展开）
 *
 * The bar sits right above the round's final assistant message (or above the
 * round's tail when the round produced no text). Hidden while collapsed:
 * every think block, every tool row, and every assistant step except the
 * final summary of that round. Clicking the bar toggles the round.
 *
 * DOM safety: the chat flow is React-managed, so foreign nodes and inline
 * styles get swept on re-render. paint() re-runs on every mutation (debounced)
 * and heals both — it re-applies display state and re-inserts/re-positions the
 * bars. The last segment of a running turn stays fully visible.
 */

/** The injected page script (exported for verification harnesses). */
export const TURN_CHROME_SCRIPT = `(() => {
  if (window.__dshTurnChrome) return;
  window.__dshTurnChrome = true;
  const api = window.dshDesktop;
  const style = document.createElement('style');
  style.textContent = \`
    .dsh-turn-bar {
      display: flex; align-items: center; gap: 8px; width: 100%;
      margin: 8px 0 4px; padding: 6px 10px; border: 0; border-radius: 10px;
      background: var(--dsw-alias-interactive-bg-hover, rgba(127,140,160,.12));
      color: var(--dsw-alias-label-secondary, #8b97ad);
      font: 12.5px/18px "Segoe UI","Microsoft YaHei",sans-serif;
      cursor: pointer; text-align: left;
    }
    .dsh-turn-bar .chev { width: 1em; display: inline-block; }
    .dsh-turn-bar .revert {
      margin-left: auto; border: 0; border-radius: 8px; padding: 2px 8px;
      background: transparent; color: inherit; cursor: pointer; flex: none;
    }
    .dsh-turn-bar .revert:hover { background: rgba(77,107,254,.18); }
  \`;
  document.head.appendChild(style);

  /** Whether a turn is in flight: composer submitting/adjudicating, or the
   *  flow's tail is the running-turn indicator. */
  const running = () => {
    const phase = document.querySelector('[data-phase]');
    if (phase !== null) {
      const value = phase.getAttribute('data-phase');
      if (value === 'submitting' || value === 'adjudicating') return true;
    }
    const flow = document.querySelector('[data-chat-flow]');
    if (flow === null || flow.lastElementChild === null) return false;
    const tail = flow.lastElementChild;
    const cls = String(tail.className || '');
    return cls.includes('turnStatus') || /deep diving/i.test(tail.textContent || '');
  };

  /** Round duration from its turn-tail row ("05:42 · 用时 4秒"). */
  const durationOf = (segment) => {
    const tail = segment.find((el) => el.getAttribute('data-chat-flow-kind') === 'turn-tail');
    const text = tail ? tail.textContent : '';
    const match = String(text || '').match(/用时\\s*([^·\\n]+)/) || String(text || '').match(/Ran for\\s+([^·\\n]+)/i);
    return match ? match[1].trim() : '';
  };

  /** File paths produced by the segment's tool rows. */
  const producedPaths = (segment) => {
    const out = [];
    for (const el of segment) {
      el.querySelectorAll('[data-produced-files-row] button[title]').forEach((btn) => {
        const title = btn.getAttribute('title');
        if (title) out.push(title);
      });
    }
    return out;
  };

  /** Expanded rounds, keyed by the segment's first row key. */
  const expanded = new Set();
  /** Elements paint() has hidden; cleared before re-applying. */
  const managed = new Set();

  const reveal = () => {
    for (const el of managed) {
      if (el.isConnected) el.style.display = '';
    }
    managed.clear();
  };

  const barOf = (flow, key) => {
    return flow.querySelector(':scope > .dsh-turn-bar[data-round="' + key + '"]');
  };

  const paint = () => {
    const flow = document.querySelector('[data-chat-flow]');
    if (flow === null) return;
    const children = [...flow.children];
    const live = running();

    // Rounds: segments split at user/steering rows (and flow boundaries).
    const rounds = [];
    let start = 0;
    for (let i = 0; i <= children.length; i += 1) {
      const kind = i < children.length ? children[i].getAttribute('data-chat-flow-kind') : null;
      if (i === children.length || kind === 'user' || kind === 'steering') {
        if (i > start) {
          const first = children[start];
          rounds.push({
            start,
            end: i,
            key: first.getAttribute('data-chat-flow-key') || ('round-' + start),
            rows: children.slice(start, i),
          });
        }
        start = i;
      }
    }

    reveal();
    const wanted = new Map();
    for (let r = 0; r < rounds.length; r += 1) {
      const round = rounds[r];
      const rows = round.rows;
      const last = rows.length - 1;
      // The final assistant step of the round anchors the bar; tool-only
      // rounds fall back to the round's last row.
      let anchor = -1;
      for (let i = last; i >= 0; i -= 1) {
        if (rows[i].getAttribute('data-chat-flow-kind') === 'assistant-step') { anchor = i; break; }
      }
      if (anchor < 0 && last >= 0) anchor = last;
      const think = [];
      for (const row of rows) {
        for (const el of row.querySelectorAll('[data-variant="think"]')) think.push(el);
      }
      const tools = rows.filter((el) => el.getAttribute('data-chat-flow-kind') === 'tool-call');
      const intermediate = [];
      if (anchor >= 0) {
        for (let i = 0; i < anchor; i += 1) {
          if (rows[i].getAttribute('data-chat-flow-kind') === 'assistant-step') intermediate.push(rows[i]);
        }
      }
      const collapsible = anchor >= 0 && (think.length > 0 || tools.length > 0 || intermediate.length > 0);
      const isLiveTail = live && r === rounds.length - 1;
      const open = expanded.has(round.key);

      if (!collapsible || isLiveTail) {
        // Keep everything visible; drop any stale bar for this round.
        const stale = barOf(flow, round.key);
        if (stale) stale.remove();
        continue;
      }

      if (!open) {
        for (const el of think) { el.style.display = 'none'; managed.add(el); }
        for (const el of tools) { el.style.display = 'none'; managed.add(el); }
        for (const el of intermediate) { el.style.display = 'none'; managed.add(el); }
      }

      // Bar: the round's fold marker, anchored above the round's tail.
      let bar = barOf(flow, round.key);
      if (bar === null) {
        bar = document.createElement('div');
        bar.className = 'dsh-turn-bar';
        bar.dataset.round = round.key;
        bar.innerHTML = '<span class="chev">▸</span><span class="label"></span><button type="button" class="revert">回退本轮修改</button>';
        bar.addEventListener('click', (event) => {
          if (event.target.closest('.revert')) return;
          if (expanded.has(round.key)) expanded.delete(round.key);
          else expanded.add(round.key);
          paint();
        });
        bar.querySelector('.revert').addEventListener('click', async (event) => {
          event.stopPropagation();
          const paths = producedPaths(round.rows);
          if (paths.length === 0) {
            alert('这一轮没有可回退的文件修改。');
            return;
          }
          if (!confirm('回退本轮对 ' + paths.length + ' 个文件的修改？')) return;
          if (api && typeof api.revertFiles === 'function') {
            const result = await api.revertFiles(paths.map((filePath) => ({ path: filePath, op: 'edit' })));
            const ok = (result?.results || []).filter((row) => row.status === 'reverted').length;
            alert(ok > 0 ? ('已回退 ' + ok + ' 个文件') : (result?.error || '回退未成功。'));
          }
        });
      }
      const anchorEl = rows[anchor];
      if (bar.nextSibling !== anchorEl) flow.insertBefore(bar, anchorEl);
      bar.style.display = '';
      const chev = bar.querySelector('.chev');
      const label = bar.querySelector('.label');
      const dur = durationOf(round.rows);
      const base = dur ? ('本轮用时 ' + dur) : '本轮思考与工具调用';
      const next = base + (open ? '（点击收起）' : '（点击展开）');
      if (chev && chev.textContent !== (open ? '▾' : '▸')) chev.textContent = open ? '▾' : '▸';
      if (label && label.textContent !== next) label.textContent = next;
      wanted.set(round.key, bar);
    }

    // Drop bars for rounds that no longer qualify.
    for (const bar of flow.querySelectorAll(':scope > .dsh-turn-bar')) {
      if (!wanted.has(bar.dataset.round)) bar.remove();
    }
  };

  let timer = 0;
  const schedule = () => {
    if (timer !== 0) return;
    timer = window.setTimeout(() => { timer = 0; paint(); }, 250);
  };
  paint();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
})()`

/** Inject turn collapse chrome. */
export async function injectTurnChrome(webContents) {
  if (webContents === undefined || webContents.isDestroyed()) return
  await webContents.executeJavaScript(TURN_CHROME_SCRIPT)
}
