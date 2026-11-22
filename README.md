# Trailweaver

Trailweaver is a mobile-first, offline-capable web app (or Progressive Web App, PWA) that records GPS tracks on your phone and highlights the paths that emerge where several different walks overlap.

Data stays in your browser, with optional sync to your own PHP and MySQL server.

## Features

- Topographic and street maps (Leaflet, OpenTopoMap, OpenStreetMap)
- GPS recording with screen wake lock and crash recovery
- Path detection from overlapping walks, colored yellow to red by pass count
- Adjustable merge distance, minimum passes, and GPS accuracy filter, with reset to defaults
- Areas: separate groups of tracks, with a prompt when you start far away; rename or move tracks
- GPX import/export and GeoJSON path export
- Map buttons: center on me, black out the screen to save battery, hide controls
- Installable, works offline, map tiles cached as you browse
- Optional token-protected sync across devices (last write wins)

## Without installation

Open the GitHub Pages address ([https://larasqp.github.io/Trailweaver](https://larasqp.github.io/Trailweaver))  in, e.g., Brave/Chrome on Android and choose Add to Home screen.

> [!CAUTION]
> In this mode, data is kept in the browser's local storage only.
> 
> Clearing site data deletes your tracks, so export GPX regularly if this is important to you.

## With installation (self-hosting)

For multi-device sync, install your own server:

1. Upload the contents of `frontend/` to a web folder served over HTTPS.
2. For sync, upload `backend/api.php` and `backend/config.php` to a PHP 7.4+ server with `pdo_mysql` (same folder as the front end, or enter the full API address in the app).
3. Create a MySQL database and a user with all privileges on it.
4. Copy `backend/config.example.php` to `config.php` and set `TW_TOKEN` (random, 16+ characters) and the `DB_*` values. Never commit it.
5. Open the site on your phone and choose Install or Add to Home screen.
6. In the Data tab, enter the same token and tap Save & sync. Tables are created automatically.
7. After each update, bump  `SHELL` in `sw.js` (eg, `v8` to `v9`) so phones fetch the new files. The Data tab shows the active version.

## License

**Trailweaver** is released under the [MIT License](LICENSE).