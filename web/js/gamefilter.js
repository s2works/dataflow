// Game filter chips for player tabs: click a game to hide/show it,
// double-click for only that game, All / None. The selection is per
// week (NFL) / day (NHL) and resets when it changes.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// `games()` returns the selected week's / day's games; `period()` its key.
export function gameFilter(games, period) {
  let off = { period: null, ids: new Set() };
  const ids = () => (off.period === period() ? off.ids : (off = { period: period(), ids: new Set() }).ids);
  const on = (id) => !ids().has(String(id));
  const teamOn = (team) => { const g = games().find((x) => x.home === team || x.away === team); return !g || on(g.game_id); };
  const active = () => games().some((g) => !on(g.game_id));

  function bar() {
    const gs = games();
    if (gs.length < 2) return '';
    const n = gs.filter((g) => on(g.game_id)).length;
    return `<div class="gamebar"><span class="muted small">Games <strong class="ink">${n}/${gs.length}</strong></span>
      <button class="gchip" data-gall="1">All</button><button class="gchip" data-gnone="1">None</button>
      ${gs.map((g) => `<button class="gchip ${on(g.game_id) ? 'on' : ''}" data-gtoggle="${esc(g.game_id)}" title="Click to show/hide · double-click for only this game">${g.away} @ ${g.home}</button>`).join('')}</div>`;
  }

  function wire(root, rerender) {
    root.querySelectorAll('[data-gtoggle]').forEach((el) => {
      const id = el.dataset.gtoggle;
      el.addEventListener('click', () => { const s = ids(); s.has(id) ? s.delete(id) : s.add(id); rerender(); });
      el.addEventListener('dblclick', () => { const s = ids(); s.clear(); for (const g of games()) if (String(g.game_id) !== id) s.add(String(g.game_id)); rerender(); });
    });
    root.querySelector('[data-gall]')?.addEventListener('click', () => { ids().clear(); rerender(); });
    root.querySelector('[data-gnone]')?.addEventListener('click', () => { for (const g of games()) ids().add(String(g.game_id)); rerender(); });
  }

  return { on, teamOn, active, bar, wire };
}
