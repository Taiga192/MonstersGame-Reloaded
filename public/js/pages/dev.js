// The "dev" page.
import { act, api, refresh, toast } from '../api.js';
import { devEnabled, me, now } from '../state.js';
import { $ } from '../util.js';

// ---------- dev panel ----------
export function renderDev() {
  const el = $('#dev');
  if (!devEnabled || !me) return void (el.innerHTML = '');
  if (el.dataset.built === '1') return;
  el.dataset.built = '1';
  el.innerHTML = `<details><summary>🛠 Test tools</summary>
    <div class="row"><input id="dg" type="number" placeholder="gold" value="1000"><button class="sm" data-dev="grant" data-f="dg:gold">+gold</button></div>
    <div class="row"><button class="sm" data-dev="blood">Fill blood tank</button></div>
    <div class="row"><input id="dl" type="number" placeholder="level" value="20"><button class="sm" data-dev="level" data-f="dl:level">Set level</button></div>
    <div class="row"><button class="sm" data-dev="heal">Full heal</button><button class="sm" data-dev="bots" data-f="dn:count">+bots</button><input id="dn" type="number" value="10"></div>
    <div class="row"><button class="sm" data-dev="arena-fill">Fill my arena event</button><button class="sm" data-dev="market">Seed market</button></div>
    <div class="row"><button class="sm" data-dev="applicants">Clan applicants</button><button class="sm" data-dev="mail">Get mail</button></div>
    <div class="row"><span class="muted">Automatic bots:</span></div>
    <div class="row"><button class="sm" data-dev="bots-report">Bot report</button><button class="sm" data-dev="bots-act">Bots act now</button><button class="sm" data-dev="bots-add">+10 bots</button></div>
    <div class="row"><input id="ds" type="number" value="200" style="width:5rem"><button class="sm" data-dev="stats" data-f="ds:value">Set all attributes</button></div>
    <div class="row"><span class="muted">Dungeon:</span><button class="sm" data-dev="dungeon" data-body='{"clearCooldown":true}'>Reset cooldown</button>
      <button class="sm" data-dev="dungeon" data-body='{"depth":9,"clearCooldown":true,"leave":true}'>Depth 9</button><button class="sm" data-dev="dungeon" data-body='{"depth":30,"clearCooldown":true,"leave":true}'>Depth 30</button></div>
    <div class="row"><span class="muted">Clan wars:</span></div>
    <div class="row"><button class="sm" data-dev="fill-clan">Fill my clan (5)</button><button class="sm" data-dev="enemy-clan">Enemy bot clan</button></div>
    <div class="row"><button class="sm" data-dev="enemy-declare">Enemy declares war</button><button class="sm" data-dev="heal-bots">Heal bots</button></div>
    <div class="row"><button class="sm" data-dev="enemy-negotiate" data-a="peace">Enemy: peace</button><button class="sm" data-dev="enemy-negotiate" data-a="ceasefire">Enemy: ceasefire</button><button class="sm" data-dev="enemy-negotiate" data-a="capitulate">Enemy: surrender</button></div>
    <div class="row"><span class="muted">Skip time:</span>
      ${[10, 60, 720, 1440].map((m) => `<button class="sm" data-dev="skip" data-m="${m}">${m >= 60 ? m / 60 + 'h' : m + 'm'}</button>`).join('')}</div></details>`;
  el.querySelectorAll('[data-dev]').forEach(
    (b) =>
      (b.onclick = async () => {
        const body = {};
        if (b.dataset.f) {
          const [id, key] = b.dataset.f.split(':');
          body[key] = Number(el.querySelector('#' + id).value);
        }
        if (b.dataset.m) body.minutes = Number(b.dataset.m);
        if (b.dataset.a) body.action = b.dataset.a;
        if (b.dataset.body) Object.assign(body, JSON.parse(b.dataset.body));
        try {
          const r = await api('/dev/' + b.dataset.dev, body);
          toast(r.message ? r.message : r.created ? `Added ${r.created.length} bots` : r.added ? `Added ${r.added} arena bots` : 'Done');
          await refresh();
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
