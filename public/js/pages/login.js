// The "login" page.
import { api, refresh, toast } from '../api.js';
import { A, img } from '../art.js';
import { catalog, setToken, token } from '../state.js';
import { $, esc } from '../util.js';

// ---------- pages ----------
export function pageLogin() {
  setTimeout(() => {
    $('#login')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const r = await api('/login', { name: f.get('name'), password: f.get('password') });
        setToken(r.token);
        localStorage.setItem('mg_token', token);
        await refresh();
        location.hash = '#/overview';
      } catch (err) {
        toast(err.message, true);
      }
    });
    $('#reg')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const ref = Number(localStorage.getItem('mg_ref')) || undefined;
        await api('/register', { name: f.get('name'), password: f.get('password'), race: f.get('race'), referrerId: ref, code: f.get('code') || undefined });
        const r = await api('/login', { name: f.get('name'), password: f.get('password') });
        setToken(r.token);
        localStorage.setItem('mg_token', token);
        await refresh();
        location.hash = '#/overview';
        toast('Welcome to the night!');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  return `${A('brand/hero') ? `<div class="hero" style="background-image:url('${A('brand/hero')}')"></div>` : ''}<div class="grid" style="max-width:800px;margin:2rem auto">
    <form id="login" class="card"><h2>Login</h2>
      <label>Name</label><input name="name" required autocomplete="username" style="width:100%">
      <label>Password</label><input name="password" type="password" required autocomplete="current-password" style="width:100%">
      <p><button>Enter</button></p></form>
    <form id="reg" class="card"><h2>Create character</h2>
      <label>Name</label><input name="name" required pattern="[A-Za-z0-9_\\-]{3,20}" style="width:100%">
      <label>Password (${catalog?.passwordMin ?? 8}-${catalog?.passwordMax ?? 128} characters)</label><input name="password" type="password" required minlength="${catalog?.passwordMin ?? 8}" maxlength="${catalog?.passwordMax ?? 128}" autocomplete="new-password" style="width:100%">
      ${catalog?.registrationRequired ? '<label>Registration code (from the server owner)</label><input name="code" required autocomplete="off" style="width:100%">' : ''}
      <label>Race</label>
      <select name="race" style="width:100%"><option value="vampire">Vampire</option><option value="werewolf">Werewolf</option></select>
      ${A('races/vampire') || A('races/werewolf') ? `<div class="row" style="justify-content:center;margin-top:.6rem">${img('races/vampire', 'portrait sm', 'Vampire')}${img('races/werewolf', 'portrait sm', 'Werewolf')}</div>` : ''}
      <p><button>Begin the war</button></p></form>
  </div><p class="center muted">Vampires and Werewolves are locked in an eternal war. Pick your side, grow strong, raid the enemy.</p>`;
}

export async function pageBite(id) {
  localStorage.setItem('mg_ref', id); // whoever bites and then registers becomes a recruit
  setTimeout(() =>
    $('#bite')?.addEventListener('click', async () => {
      try {
        const r = await api('/bite/' + id, {});
        $('#bite-res').innerHTML = `<p class="good">You feasted! Your victim earned ${r.amount} gold.</p>`;
      } catch (e) {
        $('#bite-res').innerHTML = `<p class="bad">${esc(e.message)}</p>`;
      }
    }),
  );
  return `<div class="card center"><h2>A victim link</h2><p>Someone left a victim out here. Take a bite?</p>
    <p><button id="bite">Bite!</button> <a href="#/">Join the war</a></p><div id="bite-res"></div></div>`;
}
