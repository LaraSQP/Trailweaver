# Trailweaver

Record wanderings, reveal regular paths.

Trailweaver is an offline-capable web app (PWA) that records GPS tracks on your phone and highlights the paths that emerge where several different walks overlap. Data stays in your browser, with optional sync to your own PHP and MySQL server.

## Features

- Topographic and street maps (Leaflet, OpenTopoMap, OpenStreetMap)
- GPS recording with screen wake lock and crash recovery
- Path detection from overlapping walks, colored yellow to red by pass count
- Adjustable merge distance, minimum passes, and GPS accuracy filter
- Areas: separate groups of tracks, with a prompt when you start far away
- GPX import/export and GeoJSON path export
- Installable, works offline, map tiles cached as you browse
- Optional token-protected sync across devices (last write wins)

## Installation

1. Upload the contents of `frontend/` to a web folder served over HTTPS.
2. For sync, upload `backend/api.php` and `backend/config.php` to a PHP 7.4+ server with `pdo_mysql` (same folder as the front end, or enter the full API address in the app).
3. Create a MySQL database and a user with all privileges on it.
4. Copy `backend/config.example.php` to `config.php` and set `TW_TOKEN` (random, 16+ characters) and the `DB_*` values. Never commit it.
5. Open the site on your phone and choose Install or Add to Home screen.
6. In the Data tab, enter the same token and tap Save & sync. Tables are created automatically.
