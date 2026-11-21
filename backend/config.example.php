<?php
// Server settings read by api.php. Never commit real values to a public repository.

// Shared secret sent by the app in the X-TW-Token header. Use 16+ random characters (openssl rand -hex 24).
define('TW_TOKEN', 'CHANGE-ME-TO-A-LONG-RANDOM-STRING');

// MySQL connection. The user needs all privileges on the database.
define('DB_HOST', 'localhost');
define('DB_NAME', 'your_database');
define('DB_USER', 'your_user');
define('DB_PASS', 'CHANGE-ME-DB-PASSWORD');
