<?php
// Trailweaver sync API. Requires PHP 7.4+ with pdo_mysql; tables are created on first request.
//
// GET  -> health check (counts).
// POST -> sync. Request:  { since, areas: [{id,name,updated}], tracks: [{id,area,name,start,updated,pts}], deleted: [{t,id,updated}] }
//         Response: { ok, now, areas, tracks } with everything the server changed after "since".
//         "since" null means store only, no changes returned.
// Conflicts: last write wins by the device "updated" timestamp (ms).
// Deletes keep the row as a tombstone (deleted = 1) so other devices learn about them.

require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
// Open CORS is safe because auth uses a header token, not cookies.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-TW-Token');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

function fail($code, $msg)
{
  http_response_code($code);
  echo json_encode(['error' => $msg]);
  exit;
}

// Array lookup with a default; replaces the null-coalescing operator.
function field($arr, $key, $default)
{
  return (isset($arr[$key]) === true) ? $arr[$key] : $default;
}

$method = field($_SERVER, 'REQUEST_METHOD', '');

// CORS preflight.
if ($method === 'OPTIONS')
{
  http_response_code(204);
  exit;
}

// Refuse to run with default or weak secrets.
if ((defined('TW_TOKEN') === false) || (strlen(TW_TOKEN) < 16) || (TW_TOKEN === 'CHANGE-ME-TO-A-LONG-RANDOM-STRING'))
{
  fail(500, 'Set TW_TOKEN in config.php (16+ characters)');
}
if ((defined('DB_HOST') === false) || (defined('DB_NAME') === false) || (defined('DB_USER') === false) || (defined('DB_PASS') === false) || (DB_PASS === 'CHANGE-ME-DB-PASSWORD') || (DB_NAME === '') || (DB_USER === ''))
{
  fail(500, 'Set DB_HOST, DB_NAME, DB_USER and DB_PASS in config.php');
}

// Custom header instead of Authorization, which some shared hosts strip.
$tok = field($_SERVER, 'HTTP_X_TW_TOKEN', '');
if ((is_string($tok) === false) || (hash_equals(TW_TOKEN, $tok) === false))
{
  // Delay slows down brute-force guessing.
  usleep(300000);
  fail(401, 'Bad token');
}

// BEGIN DB-SETUP (the test suite swaps this block; keep the markers)
if (extension_loaded('pdo_mysql') === false)
{
  fail(500, 'PHP extension pdo_mysql is not enabled');
}
try
{
  $db = new PDO('mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4', DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false]);
}
catch (Exception $e)
{
  // The reason goes to the server log only, so host and user names are not exposed to clients.
  error_log('Trailweaver DB connect failed: ' . $e->getMessage());
  fail(500, 'Cannot connect to the database. Check config.php');
}

// updated: device clock (ms), used for last write wins. srv: server clock (ms) at write, used for "changed since".
$db->exec('CREATE TABLE IF NOT EXISTS tw_areas ( id VARCHAR(64) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL DEFAULT \'\', updated BIGINT NOT NULL DEFAULT 0, deleted TINYINT(1) NOT NULL DEFAULT 0, srv BIGINT NOT NULL DEFAULT 0, KEY idx_areas_srv (srv) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

// pts holds the whole point list as JSON text: [[lat,lng,unixSeconds],...].
$db->exec('CREATE TABLE IF NOT EXISTS tw_tracks ( id VARCHAR(64) NOT NULL PRIMARY KEY, area VARCHAR(64) NOT NULL DEFAULT \'\', name VARCHAR(200) NOT NULL DEFAULT \'\', t_start BIGINT NOT NULL DEFAULT 0, pts MEDIUMTEXT NOT NULL, updated BIGINT NOT NULL DEFAULT 0, deleted TINYINT(1) NOT NULL DEFAULT 0, srv BIGINT NOT NULL DEFAULT 0, KEY idx_tracks_srv (srv) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
// END DB-SETUP

// Server clock is used for "since" so device clock differences do not matter.
$now = (int) round(microtime(true) * 1000);

if ($method === 'GET')
{
  echo json_encode(['ok' => true, 'areas' => (int) $db->query('SELECT COUNT(*) FROM tw_areas WHERE deleted=0')->fetchColumn(), 'tracks' => (int) $db->query('SELECT COUNT(*) FROM tw_tracks WHERE deleted=0')->fetchColumn()]);
  exit;
}

$in = json_decode(file_get_contents('php://input'), true);
if (is_array($in) === false)
{
  fail(400, 'Bad JSON');
}

$okId = function ($id)
{
  return ((is_string($id) === true) && (preg_match('/^[A-Za-z0-9_-]{1,64}$/', $id) === 1));
};

// Cut to the 200-character size of the name columns.
$str = function ($s)
{
  $s = (string) $s;
  return (function_exists('mb_substr') === true) ? mb_substr($s, 0, 200) : substr($s, 0, 200);
};

// True if the row is missing or the stored version is not newer. $table is always an internal constant.
$newer = function ($table, $id, $updated) use ($db)
{
  $s = $db->prepare("SELECT updated FROM $table WHERE id=?");
  $s->execute([$id]);
  $cur = $s->fetchColumn();
  return (($cur === false) || ((int) $cur <= $updated));
};

// One transaction: a sync is stored completely or not at all.
$db->beginTransaction();
try
{
  foreach (field($in, 'areas', []) as $a)
  {
    if ((is_array($a) === false) || ($okId(field($a, 'id', null)) === false))
    {
      continue;
    }
    $u = (int) field($a, 'updated', 0);
    if ($newer('tw_areas', $a['id'], $u) === false)
    {
      continue;
    }
    // REPLACE also revives a tombstone.
    $db->prepare('REPLACE INTO tw_areas(id,name,updated,deleted,srv) VALUES(?,?,?,0,?)')->execute([$a['id'], $str(field($a, 'name', '')), $u, $now]);
  }

  foreach (field($in, 'tracks', []) as $t)
  {
    // The point cap blocks absurdly large uploads.
    if ((is_array($t) === false) || ($okId((string) field($t, 'id', '')) === false) || (is_array(field($t, 'pts', null)) === false) || (count($t['pts']) > 300000))
    {
      continue;
    }
    $id = (string) $t['id'];
    $u = (int) field($t, 'updated', 0);
    if ($newer('tw_tracks', $id, $u) === false)
    {
      continue;
    }
    $db->prepare('REPLACE INTO tw_tracks(id,area,name,t_start,pts,updated,deleted,srv) VALUES(?,?,?,?,?,?,0,?)')->execute([$id, $str(field($t, 'area', '')), $str(field($t, 'name', '')), (int) field($t, 'start', 0), json_encode($t['pts']), $u, $now]);
  }

  foreach (field($in, 'deleted', []) as $d)
  {
    if ((is_array($d) === false) || (in_array(field($d, 't', ''), ['track', 'area'], true) === false) || ($okId((string) field($d, 'id', '')) === false))
    {
      continue;
    }
    $id = (string) $d['id'];
    $u = (int) field($d, 'updated', 0);
    $table = ($d['t'] === 'track') ? 'tw_tracks' : 'tw_areas';
    if ($newer($table, $id, $u) === false)
    {
      continue;
    }
    if ($table === 'tw_tracks')
    {
      // Drop the heavy point data and keep only the tombstone.
      $db->prepare("REPLACE INTO tw_tracks(id,area,name,t_start,pts,updated,deleted,srv) VALUES(?,'','',0,'[]',?,1,?)")->execute([$id, $u, $now]);
    }
    else
    {
      $db->prepare("REPLACE INTO tw_areas(id,name,updated,deleted,srv) VALUES(?,'',?,1,?)")->execute([$id, $u, $now]);
    }
  }
  $db->commit();
}
catch (Exception $e)
{
  if ($db->inTransaction() === true)
  {
    $db->rollBack();
  }
  error_log('Trailweaver sync failed: ' . $e->getMessage());
  fail(500, 'Database error');
}

// Intermediate upload chunks send since = null and need no reply data.
if (field($in, 'since', null) === null)
{
  echo json_encode(['ok' => true, 'now' => $now]);
  exit;
}

// Go back 2 s so rows written at nearly the same instant by two devices are not missed.
// Receiving a change twice is harmless because the app merges idempotently.
$since = max(0, (int) $in['since'] - 2000);

$s = $db->prepare('SELECT id,name,updated,deleted FROM tw_areas WHERE srv > ?');
$s->execute([$since]);
$areas = array_map(function ($r)
{
  return ['id' => $r['id'], 'name' => $r['name'], 'updated' => (int) $r['updated'], 'deleted' => (bool) $r['deleted']];
}, $s->fetchAll(PDO::FETCH_ASSOC));

$s = $db->prepare('SELECT id,area,name,t_start,pts,updated,deleted FROM tw_tracks WHERE srv > ?');
$s->execute([$since]);
$tracks = array_map(function ($r)
{
  $pts = json_decode($r['pts'], true);
  return ['id' => $r['id'], 'area' => $r['area'], 'name' => $r['name'], 'start' => (int) $r['t_start'], 'pts' => (is_array($pts) === true) ? $pts : [], 'updated' => (int) $r['updated'], 'deleted' => (bool) $r['deleted']];
}, $s->fetchAll(PDO::FETCH_ASSOC));

echo json_encode(['ok' => true, 'now' => $now, 'areas' => $areas, 'tracks' => $tracks]);
