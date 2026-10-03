// Shared client state (session, character, catalog, clock skew) with setters: imported bindings are read-only elsewhere.

export let assets = {};
export let token = localStorage.getItem('mg_token');
export let me = null;
export let catalog = null;
export let skew = 0;
export let lastResult = null;
export let devEnabled = false;
export let huntResult = null;
export let dungeonResult = null;
export const setAssets = (v) => {
  assets = v;
};
export const setToken = (v) => {
  token = v;
};
export const setMe = (v) => {
  me = v;
};
export const setCatalog = (v) => {
  catalog = v;
};
export const setSkew = (v) => {
  skew = v;
};
export const setLastResult = (v) => {
  lastResult = v;
};
export const setDevEnabled = (v) => {
  devEnabled = v;
};
export const setHuntResult = (v) => {
  huntResult = v;
};
export const setDungeonResult = (v) => {
  dungeonResult = v;
};

export const API_BASE = String(window.MG_API || '').replace(/\/+$/, ''); // '' = the server that served this page

export const LOCAL = !!window.MG_LOCAL; // browser-only build (GitHub Pages): the game runs in this browser, see local-boot.js

export const now = () => Date.now() + skew;

export const isHunting = () => me.hunt_until > now();

export const isWorking = () => me.work_until > now();

export const isInDungeon = () => me.dungeon_until > now();

export const isBusy = () => isHunting() || isWorking() || isInDungeon();
