// Deployment mode (read by index.html before app.js).
//   window.MG_LOCAL = false, window.MG_API = ''            served by the Node server itself (npm start): same origin
//   window.MG_LOCAL = false, window.MG_API = 'https://...' the frontend is hosted elsewhere (itch.io, GitHub Pages) and talks to
//                                                          your game server (npm run build:online -- --api https://...)
//   window.MG_LOCAL = true                                 browser-only single-player version (npm run build:pages)
// This file never contains secrets: everything here is readable by every player. The database is only reachable through the server.
window.MG_LOCAL = false;
window.MG_API = '';
