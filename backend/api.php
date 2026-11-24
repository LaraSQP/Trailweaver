<?php
// Trailweaver sync API. Requires PHP 7.4+ with pdo_mysql; tables are created on first request
//
// GET  -> health check (counts)
// POST -> sync. Request:  { since, areas: [{id,name,updated}], tracks: [{id,area,name,start,updated,pts}], favs: [{id,favorite}], deleted: [{t,id,updated}] }
//         Response: { ok, now, areas, tracks, favs } with everything the server changed after "since"; favs holds the ids of all favorite tracks
//         "since" null means store only, no changes returned
// Conflicts: last write wins by the device "updated" timestamp (ms); a favorite is a plain flag, written as received
// Deletes keep the row as a tombstone (deleted = 1) so other devices learn about them

// Warnings and notices go to the server log; printed to the client they would corrupt the JSON
ini_set( 'display_errors', '0' );

require __DIR__ . '/config.php';

header( 'Content-Type: application/json; charset=utf-8' );
header( 'Cache-Control: no-store' );
// Open CORS is safe because auth uses a header token, not cookies
header( 'Access-Control-Allow-Origin: *' );
header( 'Access-Control-Allow-Headers: Content-Type, X-TW-Token' );
header( 'Access-Control-Allow-Methods: GET, POST, OPTIONS' );

function fail( $code, $message )
{
	http_response_code( $code );
	echo json_encode( [ 'error' => $message ] );
	exit;
}

// Array lookup with a default; replaces the null-coalescing operator
function field( $array, $key, $default )
{
	return ( isset( $array[ $key ] ) === true ) ? $array[ $key ] : $default;
}

$method = field( $_SERVER, 'REQUEST_METHOD', '' );

// CORS preflight
if( $method === 'OPTIONS' )
{
	http_response_code( 204 );
	exit;
}

if( ( $method !== 'GET' ) && ( $method !== 'POST' ) )
{
	fail( 405, 'Method not allowed' );
}

// Refuse to run with default or weak secrets
if( ( defined( 'TW_TOKEN' ) === false ) || ( strlen( TW_TOKEN ) < 16 ) || ( TW_TOKEN === 'CHANGE-ME-TO-A-LONG-RANDOM-STRING' ) )
{
	fail( 500, 'Set TW_TOKEN in config.php (16+ characters)' );
}
if( ( defined( 'DB_HOST' ) === false ) || ( defined( 'DB_NAME' ) === false ) || ( defined( 'DB_USER' ) === false ) || ( defined( 'DB_PASS' ) === false ) || ( DB_PASS === 'CHANGE-ME-DB-PASSWORD' ) || ( DB_NAME === '' ) || ( DB_USER === '' ) )
{
	fail( 500, 'Set DB_HOST, DB_NAME, DB_USER and DB_PASS in config.php' );
}

// Custom header instead of Authorization, which some shared hosts strip
$token = field( $_SERVER, 'HTTP_X_TW_TOKEN', '' );
if( ( is_string( $token ) === false ) || ( hash_equals( TW_TOKEN, $token ) === false ) )
{
	// Delay slows down brute-force guessing
	usleep( 300000 );
	fail( 401, 'Bad token' );
}

// BEGIN DB-SETUP (the test suite swaps this block; keep the markers)
if( extension_loaded( 'pdo_mysql' ) === false )
{
	fail( 500, 'PHP extension pdo_mysql is not enabled' );
}
try
{
	$db = new PDO( 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4', DB_USER, DB_PASS, [ PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false ] );
}
catch( Exception $error )
{
	// The reason goes to the server log only, so host and user names are not exposed to clients
	error_log( 'Trailweaver DB connect failed: ' . $error->getMessage() );
	fail( 500, 'Cannot connect to the database. Check config.php' );
}

// updated: device clock (ms), used for last write wins. srv: server clock (ms) at write, used for "changed since"
$db->exec( 'CREATE TABLE IF NOT EXISTS tw_areas ( id VARCHAR(64) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL DEFAULT \'\', updated BIGINT NOT NULL DEFAULT 0, deleted TINYINT(1) NOT NULL DEFAULT 0, srv BIGINT NOT NULL DEFAULT 0, KEY idx_areas_srv (srv) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' );

// pts holds the whole point list as JSON text: [[lat,lng,unixSeconds],...]
$db->exec( 'CREATE TABLE IF NOT EXISTS tw_tracks ( id VARCHAR(64) NOT NULL PRIMARY KEY, area VARCHAR(64) NOT NULL DEFAULT \'\', name VARCHAR(200) NOT NULL DEFAULT \'\', t_start BIGINT NOT NULL DEFAULT 0, pts MEDIUMTEXT NOT NULL, updated BIGINT NOT NULL DEFAULT 0, deleted TINYINT(1) NOT NULL DEFAULT 0, favorite TINYINT(1) NOT NULL DEFAULT 0, srv BIGINT NOT NULL DEFAULT 0, KEY idx_tracks_srv (srv) ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' );
// END DB-SETUP

// Server clock is used for "since" so device clock differences do not matter
$now = (int) round( microtime( true ) * 1000 );

if( $method === 'GET' )
{
	echo json_encode( [ 'ok' => true, 'areas' => (int) $db->query( 'SELECT COUNT(*) FROM tw_areas WHERE deleted=0' )->fetchColumn(), 'tracks' => (int) $db->query( 'SELECT COUNT(*) FROM tw_tracks WHERE deleted=0' )->fetchColumn() ] );
	exit;
}

$body = file_get_contents( 'php://input' );

// PHP hands over an empty body when the upload is larger than post_max_size
if( ( $body === '' ) && ( (int) field( $_SERVER, 'CONTENT_LENGTH', 0 ) > 0 ) )
{
	fail( 413, 'Upload too large; raise post_max_size in php.ini' );
}

$request = json_decode( $body, true );
if( is_array( $request ) === false )
{
	fail( 400, 'Bad JSON' );
}

$isValidId = function( $id )
{
	return ( ( is_string( $id ) === true ) && ( preg_match( '/^[A-Za-z0-9_-]{1,64}$/', $id ) === 1 ) );
};

// Cut to the 200-character size of the name columns
$clipText = function( $text )
{
	$text = (string) $text;
	return ( function_exists( 'mb_substr' ) === true ) ? mb_substr( $text, 0, 200 ) : substr( $text, 0, 200 );
};

// True if the row is missing or the stored version is not newer, so the incoming one may be written. $table is always an internal constant
$canOverwrite = function( $table, $id, $updated ) use ( $db )
{
	$statement = $db->prepare( "SELECT updated FROM $table WHERE id=?" );
	$statement->execute( [ $id ] );
	$stored = $statement->fetchColumn();
	return ( ( $stored === false ) || ( (int) $stored <= $updated ) );
};

// One transaction: a sync is stored completely or not at all
$db->beginTransaction();
try
{
	foreach( field( $request, 'areas', [] ) as $area )
	{
		if( ( is_array( $area ) === false ) || ( $isValidId( field( $area, 'id', null ) ) === false ) )
		{
			continue;
		}
		$updated = (int) field( $area, 'updated', 0 );
		if( $canOverwrite( 'tw_areas', $area[ 'id' ], $updated ) === false )
		{
			continue;
		}
		// REPLACE also revives a tombstone
		$db->prepare( 'REPLACE INTO tw_areas(id,name,updated,deleted,srv) VALUES(?,?,?,0,?)' )->execute( [ $area[ 'id' ], $clipText( field( $area, 'name', '' ) ), $updated, $now ] );
	}

	foreach( field( $request, 'tracks', [] ) as $track )
	{
		// The point cap blocks absurdly large uploads
		if( ( is_array( $track ) === false ) || ( $isValidId( (string) field( $track, 'id', '' ) ) === false ) || ( is_array( field( $track, 'pts', null ) ) === false ) || ( count( $track[ 'pts' ] ) > 300000 ) )
		{
			continue;
		}
		$id      = (string) $track[ 'id' ];
		$updated = (int) field( $track, 'updated', 0 );
		if( $canOverwrite( 'tw_tracks', $id, $updated ) === false )
		{
			continue;
		}
		$db->prepare( 'INSERT INTO tw_tracks(id,area,name,t_start,pts,updated,deleted,srv) VALUES(?,?,?,?,?,?,0,?) ON DUPLICATE KEY UPDATE area=VALUES(area), name=VALUES(name), t_start=VALUES(t_start), pts=VALUES(pts), updated=VALUES(updated), deleted=0, srv=VALUES(srv)' )->execute( [ $id, $clipText( field( $track, 'area', '' ) ), $clipText( field( $track, 'name', '' ) ), (int) field( $track, 'start', 0 ), json_encode( $track[ 'pts' ] ), $updated, $now ] );
	}

	// Only the flag is written, so a favorite change never touches the rest of the row
	foreach( field( $request, 'favs', [] ) as $favorite )
	{
		if( ( is_array( $favorite ) === false ) || ( $isValidId( field( $favorite, 'id', null ) ) === false ) )
		{
			continue;
		}
		$db->prepare( 'UPDATE tw_tracks SET favorite=? WHERE id=? AND deleted=0' )->execute( [ ( field( $favorite, 'favorite', false ) === true ) ? 1 : 0, $favorite[ 'id' ] ] );
	}

	foreach( field( $request, 'deleted', [] ) as $deletion )
	{
		if( ( is_array( $deletion ) === false ) || ( in_array( field( $deletion, 't', '' ), [ 'track', 'area' ], true ) === false ) || ( $isValidId( (string) field( $deletion, 'id', '' ) ) === false ) )
		{
			continue;
		}
		$id      = (string) $deletion[ 'id' ];
		$updated = (int) field( $deletion, 'updated', 0 );
		$table   = ( $deletion[ 't' ] === 'track' ) ? 'tw_tracks' : 'tw_areas';
		if( $canOverwrite( $table, $id, $updated ) === false )
		{
			continue;
		}
		if( $table === 'tw_tracks' )
		{
			// Drop the heavy point data and keep only the tombstone
			$db->prepare( "REPLACE INTO tw_tracks(id,area,name,t_start,pts,updated,deleted,srv) VALUES(?,'','',0,'[]',?,1,?)" )->execute( [ $id, $updated, $now ] );
		}
		else
		{
			$db->prepare( "REPLACE INTO tw_areas(id,name,updated,deleted,srv) VALUES(?,'',?,1,?)" )->execute( [ $id, $updated, $now ] );
		}
	}
	$db->commit();
}
catch( Throwable $error )
{
	if( $db->inTransaction() === true )
	{
		$db->rollBack();
	}
	error_log( 'Trailweaver sync failed: ' . $error->getMessage() );
	fail( 500, 'Database error' );
}

// Intermediate upload chunks send since = null and need no reply data
if( field( $request, 'since', null ) === null )
{
	echo json_encode( [ 'ok' => true, 'now' => $now ] );
	exit;
}

// Go back 2 s so rows written at nearly the same instant by two devices are not missed
// Receiving a change twice is harmless because the app merges idempotently
$since = max( 0, (int) $request[ 'since' ] - 2000 );

$statement = $db->prepare( 'SELECT id,name,updated,deleted FROM tw_areas WHERE srv > ?' );
$statement->execute( [ $since ] );
$areas = array_map( function( $row )
{
	return [ 'id' => $row[ 'id' ], 'name' => $row[ 'name' ], 'updated' => (int) $row[ 'updated' ], 'deleted' => (bool) $row[ 'deleted' ] ];
}, $statement->fetchAll( PDO::FETCH_ASSOC ) );

$statement = $db->prepare( 'SELECT id,area,name,t_start,pts,updated,deleted FROM tw_tracks WHERE srv > ?' );
$statement->execute( [ $since ] );
$tracks = array_map( function( $row )
{
	$points = json_decode( $row[ 'pts' ], true );
	return [ 'id' => $row[ 'id' ], 'area' => $row[ 'area' ], 'name' => $row[ 'name' ], 'start' => (int) $row[ 't_start' ], 'pts' => ( is_array( $points ) === true ) ? $points : [], 'updated' => (int) $row[ 'updated' ], 'deleted' => (bool) $row[ 'deleted' ] ];
}, $statement->fetchAll( PDO::FETCH_ASSOC ) );

$favoriteIds = $db->query( 'SELECT id FROM tw_tracks WHERE favorite=1 AND deleted=0' )->fetchAll( PDO::FETCH_COLUMN );

echo json_encode( [ 'ok' => true, 'now' => $now, 'areas' => $areas, 'tracks' => $tracks, 'favs' => $favoriteIds ] );