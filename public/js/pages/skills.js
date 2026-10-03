// The "skills" page.
import { act, api, toast } from '../api.js';
import { A, img } from '../art.js';
import { now } from '../state.js';
import { esc, fmt, when } from '../util.js';

// ---------- skill board ----------
export let skillBoard = null,
  skillState = null,
  skillSelected = null,
  skillView = null;

export const KIND_R = { small: 9, notable: 15, keystone: 23, origin: 19, hub: 8, bridge: 9 };

export const KIND_NAME = { small: 'Minor node', notable: 'Notable', keystone: 'Keystone', origin: 'Start node (class)', hub: 'Hub', bridge: 'Bridge' };

export const SVGNS = 'http://www.w3.org/2000/svg';

export const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export async function pageSkills() {
  const [board, st] = await Promise.all([skillBoard ?? api('/skills/board'), api('/skills')]);
  skillBoard = board;
  skillState = st;
  const regionColor = (key) => board.regions.find((r) => r.key === key)?.color ?? '#8a7a8a';
  return `<div class="grid"><div class="card"><h2>Skill board</h2>
      <p><span class="${st.free ? 'gold' : ''}" style="font-size:1.3rem"><b>${st.free}</b></span> <span class="muted">of ${st.total} points to spend</span>${st.title ? ` · <b>${esc(st.title)}</b>` : ' · <span class="muted">no class yet: your first point goes on a start node</span>'}</p>
      <p class="muted">You get 1 point per level. <b>Double-click</b> a node to learn it (hover to read what it does). Start nodes and small nodes cost 1 point, <b>notables 2</b>, <b>keystones 3</b>. Pick a start node (your class) first, then take nodes that touch the ones you have. The keystone at the end of each region is a huge bonus with a drawback; the arcs between regions lead into neighbouring regions.</p>
      <div class="row"><button class="sec sm" data-skill-zoom="1.3">＋</button><button class="sec sm" data-skill-zoom="0.77">－</button><button class="sec sm" data-skill-zoom="0">fit</button>
        <button class="sec sm" data-do="/skills/respec" data-confirm="Reset the whole board for ${fmt(st.respecCost)} gold? All points come back." ${st.used ? '' : 'disabled'}>Reset board (${fmt(st.respecCost)}g)</button></div>
      <p class="muted" style="margin-top:.6rem">${board.regions.map((r) => `<a data-skill-goto="${esc(r.key)}.start" style="color:${r.color}">${img('skills/region_' + r.key, 'nav-ico') || '● '}${esc(r.name)}</a>`).join(' &nbsp; ')}</p></div>
    <div class="card"><h3>Your bonuses</h3>${st.summary.length ? `<ul style="margin:.2rem 0;padding-left:1.1rem">${st.summary.map((t) => `<li class="${t.startsWith('-') ? 'bad' : 'good'}">${esc(t)}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</div></div>
    <div class="card" style="padding:.4rem"><div id="skill-box" data-skill-board style="position:relative"><svg id="skill-svg" style="width:100%;height:70vh;min-height:420px;touch-action:none;cursor:grab;background:#0b070b ${A('skills/board_bg') ? `url('${A('skills/board_bg')}') center / cover` : ''};border-radius:6px" role="img" aria-label="skill board"></svg>
      <div id="skill-panel" class="card" style="position:absolute;left:.6rem;bottom:.6rem;max-width:340px;margin:0;display:none"></div>
      <div id="skill-tip" class="card" style="position:absolute;display:none;max-width:280px;margin:0;pointer-events:none;z-index:5;background:#120d12f2;padding:.5rem .7rem"></div></div></div>`;
}

export function initSkillBoard(box) {
  const board = skillBoard,
    st = skillState,
    svg = box.querySelector('#skill-svg');
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const taken = new Set(st.allocated),
    avail = new Set(st.available),
    reach = new Set(st.reachable);
  let drag = null,
    moved = false;
  const R = 700;
  let view = skillView; // start where the build is (or at the centre)
  if (!view) {
    const last = st.allocated.length ? byId.get(st.allocated[st.allocated.length - 1]) : null;
    view = last ? { x: last.x * 0.7, y: last.y * 0.7, k: 1.5 } : { x: 0, y: 0, k: 1 };
  }
  const apply = () => {
    const w = (2 * R) / view.k;
    svg.setAttribute('viewBox', `${view.x - w / 2} ${view.y - w / 2} ${w} ${w}`);
    skillView = view;
  };
  apply();
  const colorOf = (n) => board.regions.find((r) => n.region === r.key)?.color ?? '#9a8a9a';
  // links first (so the nodes sit on top)
  const drawn = new Set();
  for (const n of board.nodes)
    for (const l of n.links) {
      const key = [n.id, l].sort().join('|');
      if (drawn.has(key)) continue;
      drawn.add(key);
      const m = byId.get(l),
        on = taken.has(n.id) && taken.has(l);
      svgEl('line', { x1: n.x, y1: n.y, x2: m.x, y2: m.y, stroke: on ? colorOf(n) : '#3a2a3a', 'stroke-width': on ? 5 : 3, 'stroke-linecap': 'round' }, svg);
    }
  const panel = box.querySelector('#skill-panel'),
    tip = box.querySelector('#skill-tip');
  const pts = (n) => `${n} point${n === 1 ? '' : 's'}`;
  /** why a node cannot be taken right now (null when it can, or when it is already taken) */
  const status = (n) =>
    taken.has(n.id)
      ? null
      : avail.has(n.id)
        ? null
        : reach.has(n.id)
          ? `Needs ${pts(n.cost)}, you have ${st.free}.`
          : !st.allocated.length
            ? 'Pick a start node first: that is your class.'
            : 'Not connected to your nodes yet.';
  const effects = (n) =>
    `<ul style="margin:.25rem 0;padding-left:1.1rem">${n.text.map((t) => `<li class="${t.startsWith('-') ? 'bad' : 'good'}">${esc(t)}</li>`).join('')}</ul>`;
  const showPanel = () => {
    const n = skillSelected && byId.get(skillSelected);
    if (!n) {
      panel.style.display = 'none';
      return;
    }
    const have = taken.has(n.id),
      can = avail.has(n.id);
    panel.style.display = 'block';
    panel.innerHTML = `<b style="color:${colorOf(n)}">${esc(n.name)}</b> <span class="pill">${esc(KIND_NAME[n.kind])} · ${pts(n.cost)}</span>${effects(n)}
      ${
        have
          ? `<button class="sec sm" data-do="/skills/refund" data-body='${esc(JSON.stringify({ node: n.id }))}'>Take back (${fmt(st.refundCost)}g)</button> <span class="muted">${n.kind === 'origin' ? 'your class' : ''}</span>`
          : can
            ? `<button class="sm" data-do="/skills/allocate" data-body='${esc(JSON.stringify({ node: n.id }))}'>Take (${pts(n.cost)})</button> <span class="muted">or double-click the node</span>`
            : `<span class="muted">${esc(status(n))}</span>`
      }`;
    // (the panel changes without the page being redrawn, so its buttons are wired here; assigning onclick never doubles a handler)
    panel.querySelectorAll('[data-do]').forEach((el) => {
      el.onclick = () => act(el.dataset.do, JSON.parse(el.dataset.body));
    });
  };
  // the tooltip that follows the mouse
  const showTip = (e, n) => {
    const have = taken.has(n.id),
      can = avail.has(n.id);
    tip.innerHTML = `<b style="color:${colorOf(n)}">${esc(n.name)}</b> <span class="pill">${esc(KIND_NAME[n.kind])} · ${pts(n.cost)}</span>${effects(n)}
      <div class="${have ? 'good' : can ? 'gold' : 'muted'}" style="font-size:.85rem">${have ? '✔ Learned' : can ? 'Double-click to learn' : esc(status(n))}</div>`;
    tip.style.display = 'block';
    const r = box.getBoundingClientRect(),
      w = tip.offsetWidth || 240,
      h = tip.offsetHeight || 100;
    tip.style.left = `${Math.max(4, Math.min(e.clientX - r.left + 16, r.width - w - 4))}px`;
    tip.style.top = `${Math.max(4, Math.min(e.clientY - r.top + 16, r.height - h - 4))}px`;
  };
  const hideTip = () => {
    tip.style.display = 'none';
  };
  let selRing = null;
  const select = (n) => {
    skillSelected = n.id;
    selRing?.remove();
    selRing = svgEl(
      'circle',
      { cx: n.x, cy: n.y, r: (KIND_R[n.kind] ?? 9) + 11, fill: 'none', stroke: '#fff', 'stroke-width': 2, 'pointer-events': 'none' },
      svg,
    );
    showPanel();
  };
  for (const n of board.nodes) {
    const have = taken.has(n.id),
      can = avail.has(n.id),
      r = KIND_R[n.kind] ?? 9;
    const g = svgEl('g', { 'data-node': n.id, style: 'cursor:pointer' }, svg);
    if (can) svgEl('circle', { cx: n.x, cy: n.y, r: r + 7, fill: 'none', stroke: '#e6c04a', 'stroke-width': 3, opacity: 0.8 }, g);
    svgEl(
      'circle',
      {
        cx: n.x,
        cy: n.y,
        r,
        fill: have ? colorOf(n) : '#1c141c',
        stroke: have || can ? colorOf(n) : reach.has(n.id) ? '#8a6a3a' : '#4a3a4a',
        'stroke-width': n.kind === 'keystone' ? 5 : 3,
      },
      g,
    );
    if (n.kind === 'keystone' || n.kind === 'origin')
      svgEl('circle', { cx: n.x, cy: n.y, r: r - 7, fill: 'none', stroke: have ? '#fff' : colorOf(n), 'stroke-width': 2, opacity: 0.7 }, g);
    if (n.kind === 'notable')
      svgEl('circle', { cx: n.x, cy: n.y, r: r - 6, fill: have ? '#fff' : 'none', stroke: colorOf(n), 'stroke-width': 2, opacity: 0.6 }, g);
    g.addEventListener('mouseenter', (e) => {
      if (!drag) showTip(e, n);
    });
    g.addEventListener('mousemove', (e) => {
      if (!drag) showTip(e, n);
    });
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', (e) => {
      if (moved) return;
      e.stopPropagation();
      select(n);
    }); // (selecting does not redraw the board: a double click must reach the same node)
    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      hideTip();
      if (taken.has(n.id)) return toast('You already have this node. Use "Take back" in the panel to remove it.', true);
      if (!avail.has(n.id)) return toast(status(n), true);
      act('/skills/allocate', { node: n.id });
    });
  }
  const sel = skillSelected && byId.get(skillSelected);
  if (sel) select(sel);
  else showPanel();
  // pan with the pointer, zoom with the wheel and the buttons
  svg.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    moved = false;
    svg.style.cursor = 'grabbing';
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    const scale = (2 * R) / view.k / svg.getBoundingClientRect().width;
    view = { ...view, x: drag.vx - dx * scale, y: drag.vy - dy * scale };
    apply();
  });
  const endDrag = () => {
    drag = null;
    svg.style.cursor = 'grab';
    setTimeout(() => {
      moved = false;
    }, 0);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointerleave', endDrag);
  const zoom = (f) => {
    view = f === 0 ? { x: 0, y: 0, k: 1 } : { ...view, k: Math.min(6, Math.max(0.6, view.k * f)) };
    apply();
  };
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.15 : 0.87);
    },
    { passive: false },
  );
  box
    .closest('#view')
    .querySelectorAll('[data-skill-zoom]')
    .forEach((b) => {
      b.onclick = () => zoom(Number(b.dataset.skillZoom));
    });
  box
    .closest('#view')
    .querySelectorAll('[data-skill-goto]')
    .forEach((a) => {
      a.onclick = () => {
        const n = byId.get(a.dataset.skillGoto);
        if (n) {
          view = { x: n.x * 0.6, y: n.y * 0.6, k: 1.8 };
          apply();
        }
      };
    });
}
