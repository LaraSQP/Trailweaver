'use strict';
// Trailweaver app logic.
// Data (JSON in localStorage):
//   track = { id, name, start, area, updated, visible, pts }   pts = [[lat, lng, unixSeconds], ...]
//   area  = { id, name, updated }
//   tomb  = { t: 'track' | 'area', id, updated }   a deletion waiting to be synced
// "updated" is a millisecond timestamp bumped on every change; sync uses it for last-write-wins.

const $ = ( selector ) => document.querySelector( selector );

const KEY   = 'trailweaver.tracks.v1';
const CUR   = 'trailweaver.current.v1';
const SET   = 'trailweaver.settings.v1';
const AREAS = 'trailweaver.areas.v1';
const GEO   = 'geolocation' in navigator;

// localStorage can throw (private mode) or hold bad JSON, so always fall back.
const load = ( key, fallback ) =>
{
	try
	{
		const raw = localStorage.getItem( key );
		return raw !== null ? JSON.parse( raw ) : fallback;
	} catch
	{
		return fallback;
	}
};

const save = ( key, value ) =>
{
	try
	{
		localStorage.setItem( key, JSON.stringify( value ) );
	} catch
	{
		toast( 'Storage full – export your data' );
	}
};

function toast( message )
{
	const el       = $( '#toast' );
	el.textContent = message;
	el.classList.add( 'show' );
	clearTimeout( toast.h );
	toast.h = setTimeout( () => el.classList.remove( 'show' ), 2600 );
}

// Haversine distance in meters between [lat, lng] points; extra array elements are ignored.
function hav( a, b )
{
	const R    = 6371000;
	const rad  = Math.PI / 180;
	const dLat = ( b[ 0 ] - a[ 0 ] ) * rad;
	const dLng = ( b[ 1 ] - a[ 1 ] ) * rad;
	const h =
		Math.sin( dLat / 2 ) ** 2 +
		Math.cos( a[ 0 ] * rad ) * Math.cos( b[ 0 ] * rad ) * Math.sin( dLng / 2 ) ** 2;
	return 2 * R * Math.asin( Math.sqrt( h ) );
}

const trackLen = ( pts ) =>
{
	let d = 0;
	for( let i = 1; i < pts.length; i++ )
	{
		d += hav( pts[ i - 1 ], pts[ i ] );
	}
	return d;
};

const fmtKm = ( m ) => ( m / 1000 ).toFixed( 2 ) + ' km';

const fmtT = ( secs ) =>
{
	secs    = Math.max( 0, Math.round( secs ) );
	const h = Math.floor( secs / 3600 );
	const m = Math.floor( ( secs % 3600 ) / 60 );
	return (
		( h > 0 ? h + ':' + String( m ).padStart( 2, '0' ) : m ) +
		':' +
		String( secs % 60 ).padStart( 2, '0' )
	);
};

// Data saved by older versions may lack "updated"; treat that as 0.
const updatedOf = ( item ) => ( item.updated === undefined ? 0 : item.updated );

// A new walk is named after its area; the date is shown on its own line in the list.
const walkName = ( areaId ) =>
{
	const owner = areas.find( ( x ) => x.id === areaId );
	return owner !== undefined ? owner.name : 'Walk';
};

let tracks = load( KEY, [] );
let areas  = load( AREAS, null );

// Defaults for the three path sliders, also used by the "Reset to defaults" button.
// They are practical starting points for walking, not measured values; tune them to your terrain.
// cell (meters): grid size used to decide that two walks went the same way. Phone GPS typically
//   drifts 3 to 10 m in the open, so 12 m lets repeated walks of one trail share cells, while
//   trails about 25 m or more apart stay separate. Raise it under tree cover or in canyons.
// minp (walks): distinct walks that must use a link before it counts as a path. One walk is just a
//   walk, and two can be a coincidence or an out-and-back, so 3 means the route is really reused.
// maxacc (meters): fixes with a reported error above this are dropped while recording. Over 25 m
//   is usually a coarse network position or a poor sky view that would draw false jumps, while
//   weaker but usable fixes under foliage are kept.
const PATH_DEFAULTS = { cell: 12, minp: 3, maxacc: 25 };
// Stored settings override the defaults; showRaw and area are not path sliders, so they are not reset.
let settings = Object.assign(
	{ ...PATH_DEFAULTS, showRaw: true, area: null },
	load( SET, {} )
);
let current   = null;
let watchId   = null;
let wake      = null;
let timer     = null;
let lastEdges = [];

// Migration for data without areas or timestamps. The fixed 'default' id lets devices share one default area when synced.
if( Array.isArray( areas ) === false || areas.length === 0 )
{
	areas = [ { id: 'default', name: 'My area', updated: Date.now() } ];
	save( AREAS, areas );
}
for( const t of tracks )
{
	if( t.area === undefined || t.area === '' )
	{
		t.area = areas[ 0 ].id;
	}
	if( t.updated === undefined || t.updated === 0 )
	{
		t.updated = Date.now();
	}
}
for( const a of areas )
{
	if( a.updated === undefined || a.updated === 0 )
	{
		a.updated = Date.now();
	}
}
if( areas.some( ( a ) => a.id === settings.area ) === false )
{
	settings.area = areas[ 0 ].id;
	save( SET, settings );
}
save( KEY, tracks );

const curArea    = () => areas.find( ( a ) => a.id === settings.area );
const areaTracks = () => tracks.filter( ( t ) => t.area === settings.area );

const map = L.map( 'map', { zoomControl: false } ).setView( [ 20, 0 ], 2 );
// The tile URL pattern is also matched in sw.js for caching.
const topo = L.tileLayer( 'https://tile.opentopomap.org/{z}/{x}/{y}.png', {
	maxZoom     : 17,
	attribution : '© OpenTopoMap, © OpenStreetMap',
} );
const osm = L.tileLayer( 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
	maxZoom     : 19,
	attribution : '© OpenStreetMap',
} );
topo.addTo( map );
L.control.layers( { Topographic : topo, Streets: osm }, null, { position: 'topright' } ).addTo( map );
L.control.zoom( { position      : 'bottomright' } ).addTo( map );
// refresh() clears and redraws rawLayer and pathLayer; live is the line that grows while recording.
const rawLayer  = L.layerGroup().addTo( map );
const pathLayer = L.layerGroup().addTo( map );
const live      = L.polyline( [], { color: '#b3402a', weight: 4 } ).addTo( map );
const me = L.circleMarker( [ 0, 0 ], {
	radius      : 8,
	color       : '#fff',
	weight      : 3,
	fillColor   : '#2a6fb3',
	fillOpacity : 1,
} );

// Called for every GPS fix. While recording, drops fixes worse than maxacc and
// fixes closer than minStep (3 to 8 m, half the reported accuracy) to the last saved point.
function onPos( p )
{
	const c                  = p.coords;
	$( '#sAcc' ).textContent = Math.round( c.accuracy ) + ' m';
	const ll                 = [ c.latitude, c.longitude ];
	me.setLatLng( ll );
	if( map.hasLayer( me ) === false )
	{
		me.addTo( map );
	}
	if( current === null )
	{
		return;
	}
	if( c.accuracy > settings.maxacc )
	{
		return;
	}
	// First usable fix of a recording: offer to switch or create an area if far from this one.
	if( current.pts.length === 0 && current.checked !== true )
	{
		current.checked = true;
		checkArea( ll );
	}
	const last    = current.pts[ current.pts.length - 1 ];
	const minStep = Math.max( 3, Math.min( 8, c.accuracy / 2 ) );
	if( last !== undefined && hav( last, ll ) < minStep )
	{
		return;
	}
	current.pts.push( [ +ll[ 0 ].toFixed( 6 ), +ll[ 1 ].toFixed( 6 ), Math.round( p.timestamp / 1000 ) ] );
	live.addLatLng( ll );
	if( current.pts.length === 1 || current.pts.length % 3 === 0 )
	{
		map.panTo( ll, { animate: true } );
	}
	// Saved every 5th point so an unfinished walk can be recovered after a crash (see boot).
	if( current.pts.length % 5 === 0 )
	{
		save( CUR, current );
	}
	updateStats();
}

function onErr( e )
{
	toast( e.code === 1 ? 'Location permission denied' : 'GPS: ' + e.message );
}

// Browsers pause GPS when the screen turns off, so ask to keep it on.
async function keepAwake()
{
	try
	{
		wake = await navigator.wakeLock.request( 'screen' );
	} catch
	{
		// Optional feature; ignore failures.
	}
}

function updateStats()
{
	if( current === null )
	{
		return;
	}
	$( '#sDist' ).textContent = fmtKm( trackLen( current.pts ) );
	$( '#sTime' ).textContent = fmtT( Date.now() / 1000 - current.start );
}

function startRec()
{
	if( GEO === false )
	{
		return toast( 'Geolocation not supported' );
	}
	current = {
		id      : Date.now(),
		name    : '',
		start   : Math.round( Date.now() / 1000 ),
		visible : true,
		area    : settings.area,
		pts     : [],
	};
	live.setLatLngs( [] );
	watchId = navigator.geolocation.watchPosition( onPos, onErr, {
		enableHighAccuracy : true,
		maximumAge         : 0,
		timeout            : 20000,
	} );
	keepAwake();
	timer                   = setInterval( updateStats, 1000 );
	$( '#rec' ).textContent = '■ Stop recording';
	$( '#rec' ).classList.add( 'on' );
	$( '#area' ).disabled = true;
}

function stopRec()
{
	navigator.geolocation.clearWatch( watchId );
	clearInterval( timer );
	if( wake !== null )
	{
		wake.release().catch( () => undefined );
		wake = null;
	}
	if( current !== null && current.pts.length >= 2 )
	{
		current.updated = Date.now();
		// Looked up here because checkArea may have switched the area after Start.
		current.name = walkName( current.area );
		// "checked" is a transient recording flag, not part of the saved track.
		delete current.checked;
		tracks.push( current );
		save( KEY, tracks );
		toast( 'Saved ' + fmtKm( trackLen( current.pts ) ) );
	} else
	{
		toast( 'Too short – discarded' );
	}
	current = null;
	localStorage.removeItem( CUR );
	live.setLatLngs( [] );
	$( '#rec' ).textContent = '● Start recording';
	$( '#rec' ).classList.remove( 'on' );
	$( '#area' ).disabled     = false;
	$( '#sDist' ).textContent = '0.00 km';
	$( '#sTime' ).textContent = '0:00';
	autoSync();
	refresh();
}

$( '#rec' ).onclick = () =>
{
	if( current === null )
	{
		startRec();
	} else
	{
		stopRec();
	}
};

// Returning to the app releases the wake lock, so request it again.
function onVisibility()
{
	if( document.visibilityState === 'visible' && current !== null )
	{
		keepAwake();
	}
}
document.addEventListener( 'visibilitychange', onVisibility );

// Centers on the device position. Works without recording, so it asks for a one-time fix.
$( '#locate' ).onclick = () =>
{
	if( GEO === false )
	{
		return toast( 'Geolocation not supported' );
	}
	toast( 'Locating…' );
	navigator.geolocation.getCurrentPosition(
		( p ) =>
		{
			const ll = [ p.coords.latitude, p.coords.longitude ];
			me.setLatLng( ll );
			if( map.hasLayer( me ) === false )
			{
				me.addTo( map );
			}
			map.setView( ll, Math.max( map.getZoom(), 16 ) );
		},
		onErr,
		{ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
	);
};

// The map is resized after the panel changes height, otherwise Leaflet keeps the old size.
$( '#toggle' ).onclick = () =>
{
	const hidden = $( '#panel' ).classList.toggle( 'hide' );
	const icon   = $( '#toggleIcon' );
	icon.classList.toggle( 'codicon-menu', hidden );
	icon.classList.toggle( 'codicon-close', hidden === false );
	setTimeout( () => map.invalidateSize(), 50 );
};

// Pure black layer to save battery on OLED screens; a tap anywhere restores the app.
// The theme color is switched too, so the status bar goes black where the browser allows it.
const themeMeta  = document.querySelector( 'meta[name="theme-color"]' );
const themeColor = themeMeta.content;

$( '#blackout' ).onclick = () =>
{
	$( '#blackLayer' ).classList.add( 'show' );
	themeMeta.content = '#000000';
};

$( '#blackLayer' ).onclick = () =>
{
	$( '#blackLayer' ).classList.remove( 'show' );
	themeMeta.content = themeColor;
};

// 3-point moving average to calm GPS jitter; the end points are kept as they are.
function smooth( pts )
{
	if( pts.length < 3 )
	{
		return pts;
	}
	const out = [];
	for( let i = 0; i < pts.length; i++ )
	{
		if( i === 0 || i === pts.length - 1 )
		{
			out.push( pts[ i ] );
		} else
		{
			out.push( [
				( pts[ i - 1 ][ 0 ] + pts[ i ][ 0 ] + pts[ i + 1 ][ 0 ] ) / 3,
				( pts[ i - 1 ][ 1 ] + pts[ i ][ 1 ] + pts[ i + 1 ][ 1 ] ) / 3,
			] );
		}
	}
	return out;
}

// Path detection. A grid of cell-sized squares is laid over the ground and each track is converted
// into the sequence of cells it passes through. Every step between neighboring cells is a "link".
// Links used by at least minPasses DIFFERENT tracks are paths. Walks that stay within about one
// cell of each other share cells, which is what merges meandering walks into one path.
// Returns { edges: [{ a, b, n }], max, km } where km is the total length in meters.
function computePaths( list, cell, minPasses )
{
	const all = list.filter( ( t ) => t.pts.length > 1 );
	if( all.length === 0 )
	{
		return { edges: [], max: 0, km: 0 };
	}
	// Local meters around the first point.
	const lat0 = all[ 0 ].pts[ 0 ][ 0 ];
	const lng0 = all[ 0 ].pts[ 0 ][ 1 ];
	const kx   = 111320 * Math.cos( ( lat0 * Math.PI ) / 180 );
	const ky   = 110540;
	// Link key "cellA|cellB" (sorted, so both directions match) -> number of tracks that used it.
	const counts = new Map();
	for( const t of all )
	{
		const p   = smooth( t.pts ).map( ( q ) => [ ( q[ 1 ] - lng0 ) * kx, ( q[ 0 ] - lat0 ) * ky ] );
		const seq = [];
		let prev  = null;
		const add = ( x, y ) =>
		{
			const cx  = Math.floor( x / cell );
			const cy  = Math.floor( y / cell );
			const key = cx + ',' + cy;
			if( key !== prev )
			{
				seq.push( [ cx, cy ] );
				prev = key;
			}
		};
		add( p[ 0 ][ 0 ], p[ 0 ][ 1 ] );
		for( let i = 1; i < p.length; i++ )
		{
			const dx = p[ i ][ 0 ] - p[ i - 1 ][ 0 ];
			const dy = p[ i ][ 1 ] - p[ i - 1 ][ 1 ];
			const d  = Math.hypot( dx, dy );
			// A jump over 250 m is a GPS gap: break the sequence instead of drawing a straight line.
			if( d > 250 )
			{
				seq.push( null );
				prev = null;
				add( p[ i ][ 0 ], p[ i ][ 1 ] );
				continue;
			}
			// Half-cell steps so no cell is skipped between distant points.
			const n = Math.max( 1, Math.ceil( d / ( cell / 2 ) ) );
			for( let s = 1; s <= n; s++ )
			{
				add( p[ i - 1 ][ 0 ] + ( dx * s ) / n, p[ i - 1 ][ 1 ] + ( dy * s ) / n );
			}
		}
		// Each link counts once per track, so pacing over the same ground is still one walk.
		const seen = new Set();
		for( let i = 1; i < seq.length; i++ )
		{
			const a = seq[ i - 1 ];
			const b = seq[ i ];
			if( a === null || b === null )
			{
				continue;
			}
			const ka = a.join( ',' );
			const kb = b.join( ',' );
			const k  = ka < kb ? ka + '|' + kb : kb + '|' + ka;
			if( seen.has( k ) === false )
			{
				seen.add( k );
				const before = counts.get( k );
				counts.set( k, before === undefined ? 1 : before + 1 );
			}
		}
	}
	const toLL  = ( c ) => [ lat0 + ( ( c[ 1 ] + 0.5 ) * cell ) / ky, lng0 + ( ( c[ 0 ] + 0.5 ) * cell ) / kx ];
	const edges = [];
	let max     = 0;
	let km      = 0;
	for( const [ k, n ] of counts )
	{
		if( n < minPasses )
		{
			continue;
		}
		const [ a, b ] = k.split( '|' ).map( ( s ) => s.split( ',' ).map( Number ) );
		const A        = toLL( a );
		const B        = toLL( b );
		edges.push( { a: A, b: B, n: n } );
		max = Math.max( max, n );
		// Despite the name, this accumulates meters.
		km += hav( A, B );
	}
	return { edges: edges, max: max, km: km };
}

// Yellow (few passes) to red (many passes).
const ramp = ( n, max ) =>
{
	const t = max <= settings.minp ? 1 : ( n - settings.minp ) / ( max - settings.minp );
	return `hsl(${50 - 50 * t},90%,${52 - 8 * t}%)`;
};

// Single redraw entry point; call it after any data change.
function refresh()
{
	rawLayer.clearLayers();
	pathLayer.clearLayers();
	const vis = areaTracks().filter( ( t ) => t.visible !== false );
	if( settings.showRaw === true )
	{
		vis.forEach( ( t ) =>
			L.polyline(
				t.pts.map( ( p ) => [ p[ 0 ], p[ 1 ] ] ),
				{ color: '#3a6ea5', weight: 4, opacity: 0.85 }
			).addTo( rawLayer )
		);
	}
	const r   = computePaths( vis, +settings.cell, +settings.minp );
	lastEdges = r.edges;
	for( const e of r.edges )
	{
		L.polyline( [ e.a, e.b ], {
			color   : ramp( e.n, r.max ),
			weight  : 3 + Math.min( 6, e.n - settings.minp ),
			opacity : 0.95,
			lineCap : 'round',
		} )
			.bindTooltip( e.n + ' passes' )
			.addTo( pathLayer );
	}
	$( '#sPaths' ).textContent = ( r.km / 1000 ).toFixed( 2 );
	renderAreas();
	renderList();
}


// Icon-only button. icon is a codicon name, tone picks the color class (ic-<tone> in styles.css).
const iconButton = ( icon, tone, label ) =>
{
	const b     = document.createElement( 'button' );
	const g     = document.createElement( 'span' );
	g.className = 'codicon codicon-' + icon + ' ico ic-' + tone;
	b.className = 'sm';
	b.title     = label;
	b.setAttribute( 'aria-label', label );
	b.appendChild( g );
	return b;
};

function renderList()
{
	const el = $( '#list' );
	if( areaTracks().length === 0 )
	{
		el.innerHTML = '<p class="hint">No tracks in this area yet. Press Start, walk, then Stop. Paths appear in orange→red where several walks overlap.</p>';
		return;
	}

	el.innerHTML = '';
	const list   = areaTracks().slice().reverse();

	for( const t of list )
	{
		const row     = document.createElement( 'div' );
		row.className = 'track';

		const cb   = document.createElement( 'input' );
		cb.type    = 'checkbox';
		cb.checked = ( t.visible !== false );
		cb.setAttribute( 'aria-label', 'Show ' + t.name + ' on map' );
		cb.className = 'track-check';

		const info     = document.createElement( 'div' );
		info.className = 'track-info';

		const name       = document.createElement( 'div' );
		name.className   = 'track-name';
		name.textContent = t.name;

		const date     = document.createElement( 'div' );
		date.className = 'track-date';
		if( ( Number.isFinite( t.start ) === true ) && ( t.start > 0 ) )
		{
			date.textContent = new Date( t.start * 1000 ).toLocaleString( [], { dateStyle: 'short', timeStyle: 'short' } );
		}

		const meta       = document.createElement( 'div' );
		meta.className   = 'track-meta';
		meta.textContent = fmtKm( trackLen( t.pts ) ) + ' · ' + t.pts.length + ' pts';

		info.append( name, date, meta );

		const actions     = document.createElement( 'div' );
		actions.className = 'track-actions';

		const z  = iconButton( 'location', 'zoom', 'Find track on map' );
		const mv = iconButton( 'move', 'move', 'Move track to another area' );
		const rn = iconButton( 'edit', 'rename', 'Rename track' );
		const d  = iconButton( 'trash', 'delete', 'Delete track' );

		actions.append( z, mv, rn, d );
		row.append( cb, info, actions );

		mv.onclick = () =>
		{
			const others = areas.filter( ( a ) => a.id !== settings.area );
			if( others.length === 0 )
			{
				return toast( 'Create another area first' );
			}

			const s = prompt( 'Move this track to which area?\n' + others.map( ( a, i ) => ( i + 1 ) + ') ' + a.name ).join( '\n' ) );
			const a = others[ ( +s ) - 1 ];

			if( a !== undefined )
			{
				t.area    = a.id;
				t.updated = Date.now();
				autoSync();
				save( KEY, tracks );
				refresh();
				toast( 'Moved to ' + a.name );
			}
		};

		rn.onclick = () =>
		{
			const n = prompt( 'Rename track:', t.name );
			if( n !== null && n.trim() !== '' )
			{
				t.name    = n.trim();
				t.updated = Date.now();
				save( KEY, tracks );
				refresh();
				autoSync();
			}
		};

		cb.onchange = () =>
		{
			t.visible = cb.checked;
			save( KEY, tracks );
			refresh();
		};

		z.onclick = () => map.fitBounds( L.latLngBounds( t.pts.map( ( p ) => [ p[ 0 ], p[ 1 ] ] ) ), { padding: [ 30, 30 ] } );

		d.onclick = () =>
		{
			if( confirm( 'Delete this track?' ) === true )
			{
				tombstone( 'track', t.id );
				tracks = tracks.filter( ( x ) => x !== t );
				save( KEY, tracks );
				refresh();
				autoSync();
			}
		};

		el.appendChild( row );
	}
}

// Data tab footer: app.js version plus the cache names created by sw.js. Two caches listed means
// an update is waiting; a version that differs from the expected one means a stale file.
// Data tab footer: the version comes from SHELL in sw.js (the only place to bump it).
// Two versions listed means an update is waiting, ie, a version that differs from the expected one means a stale file.
const showVersion = async () =>
{
	let cache = 'none';
	try
	{
		const names = ( await caches.keys() ).filter( ( k ) => k.startsWith( 'trailweaver-shell-' ) );
		cache       = names.length > 0 ? names.map( ( k ) => k.slice( 18 ) ).join( ', ' ) : 'none';
	} catch
	{
		cache = 'unavailable';
	}
	$( '#ver' ).textContent = 'Version: ' + cache;
};

// Fit the map to the current area, or to the device position if the area has no tracks.
function fitAll()
{
	const pts = areaTracks().flatMap( ( t ) => t.pts.map( ( p ) => [ p[ 0 ], p[ 1 ] ] ) );
	if( pts.length > 0 )
	{
		map.fitBounds( L.latLngBounds( pts ), { padding: [ 30, 30 ] } );
	} else if( GEO === true )
	{
		navigator.geolocation.getCurrentPosition(
			( p ) => map.setView( [ p.coords.latitude, p.coords.longitude ], 15 ),
			() => undefined,
			{ timeout: 8000 }
		);
	}
}

// The value label follows the slider while dragging; save and redraw only on release.
function bindSetting( id, key, vid, unit )
{
	const el      = $( '#' + id );
	const v       = $( '#' + vid );
	el.value      = settings[ key ];
	v.textContent = settings[ key ] + unit;
	el.oninput    = () =>
	{
		settings[ key ] = +el.value;
		v.textContent   = el.value + unit;
	};
	el.onchange = () =>
	{
		save( SET, settings );
		refresh();
	};
}

bindSetting( 'cell', 'cell', 'vCell', ' m' );
bindSetting( 'minp', 'minp', 'vMin', '×' );
bindSetting( 'maxacc', 'maxacc', 'vAcc', ' m' );

$( '#pathReset' ).onclick = () =>
{
	Object.assign( settings, PATH_DEFAULTS );
	bindSetting( 'cell', 'cell', 'vCell', ' m' );
	bindSetting( 'minp', 'minp', 'vMin', '×' );
	bindSetting( 'maxacc', 'maxacc', 'vAcc', ' m' );
	save( SET, settings );
	refresh();
	toast( 'Path settings reset' );
};

$( '#showRaw' ).checked  = settings.showRaw;
$( '#showRaw' ).onchange = ( e ) =>
{
	settings.showRaw = e.target.checked;
	save( SET, settings );
	refresh();
};

// Tab button data-t="x" shows the element with id "t-x".
for( const b of document.querySelectorAll( '.tabs button' ) )
{
	b.onclick = () =>
	{
		for( const x of document.querySelectorAll( '.tabs button,.tab' ) )
		{
			x.classList.remove( 'active' );
		}
		b.classList.add( 'active' );
		$( '#t-' + b.dataset.t ).classList.add( 'active' );
	};
}

function download( name, text, type )
{
	const a    = document.createElement( 'a' );
	a.href     = URL.createObjectURL( new Blob( [ text ], { type: type } ) );
	a.download = name;
	a.click();
	setTimeout( () => URL.revokeObjectURL( a.href ), 1000 );
}

// Each track gets <type>trailweaver:AreaName</type> so importing the file restores its area.
const exportGpx = ( list, fname ) =>
{
	if( list.length === 0 )
	{
		return toast( 'Nothing to export' );
	}
	const esc   = ( s ) => String( s ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' );
	const parts = [];
	for( const t of list )
	{
		const owner    = areas.find( ( a ) => a.id === t.area );
		const areaName = owner !== undefined ? owner.name : '';
		let seg        = '';
		for( const p of t.pts )
		{
			const hasTime = Number.isFinite( p[ 2 ] ) === true && p[ 2 ] !== 0;
			const time =
				hasTime === true ? `<time>${new Date( p[ 2 ] * 1000 ).toISOString()}</time>` : '';
			seg += `<trkpt lat = "${p[ 0 ]}" lon="${p[ 1 ]}">${time}</trkpt>`;
		}
		parts.push(
			`<trk><name>${esc( t.name )}</name><type>trailweaver:${esc( areaName )}</type><trkseg>${seg}</trkseg></trk>`
		);
	}
	const x = parts.join( '\n' );
	download(
		fname,
		`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trailweaver" xmlns="http://www.topografix.com/GPX/1/1">\n${x}\n</gpx>`,
		'application/gpx+xml'
	);
};

const safeName = () => curArea().name.replace( /[^\p{L}\p{N}]+/gu, '_' );

$( '#exGpx' ).onclick = () => exportGpx( areaTracks(), 'trailweaver-' + safeName() + '.gpx' );
$( '#exAll' ).onclick = () => exportGpx( tracks, 'trailweaver-all-areas.gpx' );

// GeoJSON coordinates are [longitude, latitude], the reverse of the internal [lat, lng].
$( '#exGeo' ).onclick = () =>
{
	if( lastEdges.length === 0 )
	{
		return toast( 'No paths yet – lower the pass threshold?' );
	}
	const features = lastEdges.map( ( e ) => ( {
		type       : 'Feature',
		properties : { passes: e.n },
		geometry: {
			type: 'LineString',
			coordinates: [
				[ e.a[ 1 ], e.a[ 0 ] ],
				[ e.b[ 1 ], e.b[ 0 ] ],
			],
		},
	} ) );
	const fc = { type: 'FeatureCollection', features: features };
	download(
		'trailweaver-paths-' + safeName() + '.geojson',
		JSON.stringify( fc ),
		'application/geo+json'
	);
};

$( '#imp' ).onclick = () => $( '#file' ).click();

$( '#file' ).onchange = async ( e ) =>
{
	let added = 0;
	for( const f of e.target.files )
	{
		const doc  = new DOMParser().parseFromString( await f.text(), 'text/xml' );
		const trks = doc.querySelectorAll( 'trk' );
		for( let i = 0; i < trks.length; i++ )
		{
			const trk = trks[ i ];
			const pts = [];
			for( const p of trk.querySelectorAll( 'trkpt' ) )
			{
				const timeEl = p.querySelector( 'time' );
				const secs =
					timeEl !== null ? Math.round( Date.parse( timeEl.textContent ) / 1000 ) : 0;
				pts.push( [ +p.getAttribute( 'lat' ), +p.getAttribute( 'lon' ), secs ] );
			}
			if( pts.length > 1 )
			{
				// Only our own "trailweaver:" marker may create areas; other apps use <type> for things like "hiking".
				const typeEl = trk.querySelector( 'type' );
				const ty     = typeEl !== null ? typeEl.textContent.trim()               : '';
				const an     = ty.startsWith( 'trailweaver:' ) === true ? ty.slice( 12 ) : '';
				let ar;
				if( an !== '' )
				{
					ar = areas.find( ( a ) => a.name === an );
					if( ar === undefined )
					{
						ar = { id: 'a' + Date.now() + '_' + added, name: an, updated: Date.now() };
						areas.push( ar );
					}
				}
				const nameEl = trk.querySelector( 'name' );
				let nm       = f.name;
				if( nameEl !== null && nameEl.textContent !== '' )
				{
					nm = nameEl.textContent;
				}
				// "+ added" keeps ids unique within one import.
				const track = {
					area    : ar !== undefined ? ar.id : settings.area,
					updated : Date.now(),
					id      : Date.now() + added,
					name    : nm + ( i > 0 ? ' #' + ( i + 1 ) : '' ),
					start   : pts[ 0 ][ 2 ],
					visible : true,
					pts     : pts,
				};
				tracks.push( track );
				added++;
			}
		}
	}
	e.target.value = '';
	save( KEY, tracks );
	save( AREAS, areas );
	refresh();
	fitAll();
	autoSync();
	toast( added + ' track(s) imported' );
};

$( '#wipe' ).onclick = () =>
{
	const where = srv.token !== '' ? ', here and on the server' : ' on this device';
	if( confirm( 'Delete ALL tracks in ALL areas' + where + '?' ) === true )
	{
		tracks.forEach( ( t ) => tombstone( 'track', t.id ) );
		tracks = [];
		save( KEY, tracks );
		refresh();
		autoSync();
	}
};

// Adds 7 synthetic walks along one loose route; each wobbles randomly around it, like a person wandering.
$( '#demo' ).onclick = () =>
{
	const c  = map.getCenter();
	const o  = [ c.lat, c.lng ];
	const m  = 1 / 110540;
	const mx = 1 / ( 111320 * Math.cos( ( o[ 0 ] * Math.PI ) / 180 ) );
	const route = [
		[ -300, -200 ],
		[ -100, -50 ],
		[ 80, 40 ],
		[ 250, 220 ],
		[ 400, 150 ],
	];
	for( let w = 0; w < 7; w++ )
	{
		const pts = [];
		let off   = [ 0, 0 ];
		let t     = Math.round( Date.now() / 1000 ) - 86400 * ( 7 - w );
		for( let i = 1; i < route.length; i++ )
		{
			const a = route[ i - 1 ];
			const b = route[ i ];
			const n = Math.round( Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) / 5 );
			for( let s = 0; s < n; s++ )
			{
				off = [
					off[ 0 ] * 0.93 + ( Math.random() - 0.5 ) * 9,
					off[ 1 ] * 0.93 + ( Math.random() - 0.5 ) * 9,
				];
				const x = a[ 0 ] + ( ( b[ 0 ] - a[ 0 ] ) * s ) / n + off[ 0 ];
				const y = a[ 1 ] + ( ( b[ 1 ] - a[ 1 ] ) * s ) / n + off[ 1 ];
				t += 4;
				pts.push( [ +( o[ 0 ] + y * m ).toFixed( 6 ), +( o[ 1 ] + x * mx ).toFixed( 6 ), t ] );
			}
		}
		const track = {
			area    : settings.area,
			updated : Date.now(),
			id      : Date.now() + w,
			name    : 'Demo walk ' + ( w + 1 ),
			start   : pts[ 0 ][ 2 ],
			visible : true,
			pts     : pts,
		};
		tracks.push( track );
	}
	save( KEY, tracks );
	refresh();
	fitAll();
	toast( 'Demo walks added – paths emerge where they overlap' );
};

function renderAreas()
{
	const s     = $( '#area' );
	s.innerHTML = '';
	for( const a of areas )
	{
		const o       = document.createElement( 'option' );
		o.value       = a.id;
		o.textContent = a.name + ' (' + tracks.filter( ( t ) => t.area === a.id ).length + ')';
		if( a.id === settings.area )
		{
			o.selected = true;
		}
		s.appendChild( o );
	}
}

// A recording in progress follows into the new area.
function setArea( id )
{
	settings.area = id;
	save( SET, settings );
	if( current !== null )
	{
		current.area = id;
	}
	refresh();
	fitAll();
}

function newArea( name )
{
	const a = { id: 'a' + Date.now(), name: name.trim(), updated: Date.now() };
	areas.push( a );
	save( AREAS, areas );
	setArea( a.id );
	autoSync();
}

// Distance in meters to the nearest point of the given tracks (checks every 3rd point).
const nearestM = ( list, ll ) =>
{
	let best = Infinity;
	for( const t of list )
	{
		for( let i = 0; i < t.pts.length; i += 3 )
		{
			const d = hav( ll, t.pts[ i ] );
			if( d < best )
			{
				best = d;
			}
		}
	}
	return best;
};

// Runs at the first fix of a recording. More than 3 km from this area's tracks: offer the nearest
// other area within 1.5 km, otherwise offer a new area. Declining keeps the current area.
function checkArea( ll )
{
	const mine = areaTracks();
	if( mine.length === 0 || nearestM( mine, ll ) < 3000 )
	{
		return;
	}
	const others = areas.filter( ( a ) => a.id !== settings.area );
	const dists = others.map( ( a ) => ( {
		a: a,
		d: nearestM(
			tracks.filter( ( t ) => t.area === a.id ),
			ll
		),
	} ) );
	const near = dists.filter( ( x ) => x.d < 1500 ).sort( ( x, y ) => x.d - y.d );
	if( near.length > 0 )
	{
		if(
			confirm(
				'You are near "' +
				near[ 0 ].a.name +
				'". Record there instead of "' +
				curArea().name +
				'"?'
			) === true
		)
		{
			setArea( near[ 0 ].a.id );
		}
		return;
	}
	if( confirm( 'You are far from "' + curArea().name + '". Start a new area here?' ) === true )
	{
		const n = prompt( 'Name for the new area:', 'New area' );
		if( n !== null && n.trim() !== '' )
		{
			newArea( n );
		}
	}
}

$( '#area' ).onchange = ( e ) => setArea( e.target.value );

$( '#aNew' ).onclick = () =>
{
	const n = prompt( 'Name for the new area:' );
	if( n !== null && n.trim() !== '' )
	{
		newArea( n );
	}
};

$( '#aRen' ).onclick = () =>
{
	const n = prompt( 'Rename area:', curArea().name );
	if( n !== null && n.trim() !== '' )
	{
		curArea().name    = n.trim();
		curArea().updated = Date.now();
		save( AREAS, areas );
		renderAreas();
		autoSync();
	}
};

// Deleting an area also deletes its tracks; tombstones let other devices do the same.
$( '#aDel' ).onclick = () =>
{
	if( areas.length < 2 )
	{
		return toast( 'Keep at least one area' );
	}
	const n = areaTracks().length;
	if( confirm( 'Delete "' + curArea().name + '" and its ' + n + ' track(s)?' ) === true )
	{
		const id = settings.area;
		tracks.filter( ( t ) => t.area === id ).forEach( ( t ) => tombstone( 'track', t.id ) );
		tombstone( 'area', id );
		tracks = tracks.filter( ( t ) => t.area !== id );
		areas  = areas.filter( ( a ) => a.id !== id );
		save( KEY, tracks );
		save( AREAS, areas );
		setArea( areas[ 0 ].id );
		autoSync();
	}
};

// Optional sync with api.php; it does nothing until a token is entered. Each sync uploads items
// changed since the last one, then merges what the server changed (newer "updated" wins).
// Deletions travel as tombstones because a deleted item no longer exists to upload.
const SRV  = 'trailweaver.server.v1';
const TOMB = 'trailweaver.tomb.v1';
// pull: server clock (ms) from the last sync, sent back as "since".
// push: device clock (ms) when the last sync started; items updated after it are unsent.
let srv     = Object.assign( { url: '', token: '', pull: 0, push: 0 }, load( SRV, {} ) );
let tomb    = load( TOMB, [] );
let syncing = false;

// Device ids are numbers, server ids are strings.
const same   = ( a, b ) => String( a ) === String( b );
const srvUrl = () =>
	srv.url.trim() !== '' ? srv.url.trim() : new URL( 'api.php', location.href ).href;

const setStatus = ( m ) =>
{
	$( '#srvStatus' ).textContent = m;
};

function tombstone( t, id )
{
	tomb.push( { t: t, id: String( id ), updated: Date.now() } );
	save( TOMB, tomb );
}

const autoSync = () =>
{
	if( srv.token !== '' )
	{
		syncNow( false );
	}
};

// "manual" is true when a button started the sync; only then are results shown as toasts.
async function syncNow( manual )
{
	if( srv.token === '' )
	{
		if( manual === true )
		{
			toast( 'Enter your secret token first' );
		}
		return;
	}
	if( syncing === true )
	{
		return;
	}
	// Never sync mid-recording.
	if( current !== null )
	{
		if( manual === true )
		{
			toast( 'Stop recording first, it syncs automatically afterwards' );
		}
		return;
	}
	syncing = true;
	setStatus( 'Syncing…' );
	// Taken before collecting changes, so anything modified during the sync is sent next time.
	const startedAt = Date.now() - 1;
	try
	{
		const dA = areas.filter( ( a ) => updatedOf( a ) > srv.push );
		const dT = tracks.filter( ( t ) => updatedOf( t ) > srv.push );
		const dD = tomb.filter( ( d ) => d.updated > srv.push );
		const slim = ( t ) => ( {
			id      : String( t.id ),
			area    : t.area,
			name    : t.name,
			start   : Number.isFinite( t.start ) === true ? t.start : 0,
			updated : t.updated,
			pts     : t.pts,
		} );
		// Upload 20 tracks per request. Only the last request asks for the server's changes (since is
		// set); earlier ones send since: null, meaning "store only".
		const chunks = [];
		for( let i = 0; i < dT.length; i += 20 )
		{
			chunks.push( dT.slice( i, i + 20 ) );
		}
		if( chunks.length === 0 )
		{
			chunks.push( [] );
		}
		let res;
		for( let i = 0; i < chunks.length; i++ )
		{
			const first = i === 0;
			const last  = i === chunks.length - 1;
			const body = {
				since   : last === true ? srv.pull : null,
				areas   : first === true ? dA : [],
				deleted : first === true ? dD : [],
				tracks  : chunks[ i ].map( slim ),
			};
			const r = await fetch( srvUrl(), {
				method  : 'POST',
				headers : { 'Content-Type': 'application/json', 'X-TW-Token': srv.token },
				body    : JSON.stringify( body ),
			} );
			if( r.ok === false )
			{
				let msg = 'server error ' + r.status;
				try
				{
					const j = await r.json();
					if( j.error !== undefined )
					{
						msg = j.error;
					}
				} catch
				{
					// The error body was not JSON.
				}
				throw new Error( msg );
			}
			res = await r.json();
		}
		// Merge the server's changes. A deletion is ignored if the local copy is newer, and the last area is never removed.
		let changed    = false;
		const srvAreas = res.areas === undefined ? [] : res.areas;
		for( const a of srvAreas )
		{
			const i = areas.findIndex( ( x ) => same( x.id, a.id ) );
			if( a.deleted === true )
			{
				if( i >= 0 && areas.length > 1 && updatedOf( areas[ i ] ) <= a.updated )
				{
					areas.splice( i, 1 );
					changed = true;
				}
			} else if( i < 0 )
			{
				areas.push( { id: a.id, name: a.name, updated: a.updated } );
				changed = true;
			} else if( a.updated > updatedOf( areas[ i ] ) )
			{
				areas[ i ].name    = a.name;
				areas[ i ].updated = a.updated;
				changed            = true;
			}
		}
		const srvTracks = res.tracks === undefined ? [] : res.tracks;
		for( const t of srvTracks )
		{
			const i = tracks.findIndex( ( x ) => same( x.id, t.id ) );
			if( t.deleted === true )
			{
				if( i >= 0 && updatedOf( tracks[ i ] ) <= t.updated )
				{
					tracks.splice( i, 1 );
					changed = true;
				}
			} else if( i < 0 )
			{
				tracks.push( {
					id      : t.id,
					area    : t.area,
					name    : t.name,
					start   : t.start,
					visible : true,
					updated : t.updated,
					pts     : t.pts,
				} );
				changed = true;
			} else if( t.updated > updatedOf( tracks[ i ] ) )
			{
				// Points never change after recording, so only these fields are updated.
				Object.assign( tracks[ i ], { area: t.area, name: t.name, updated: t.updated } );
				changed = true;
			}
		}
		// Tracks whose area was deleted elsewhere move to the first area.
		for( const t of tracks )
		{
			if( areas.some( ( a ) => same( a.id, t.area ) ) === false )
			{
				t.area = areas[ 0 ].id;
			}
		}
		if( areas.some( ( a ) => a.id === settings.area ) === false )
		{
			settings.area = areas[ 0 ].id;
			save( SET, settings );
		}
		srv.pull = res.now;
		srv.push = startedAt;
		save( SRV, srv );
		save( KEY, tracks );
		save( AREAS, areas );
		if( changed === true )
		{
			refresh();
		}
		setStatus(
			'Synced ' + new Date().toLocaleTimeString() + ' · sent ' + dT.length + ' track(s)'
		);
		if( manual === true )
		{
			toast( 'Synced' );
		}
	} catch( e )
	{
		setStatus( 'Sync failed: ' + e.message );
		if( manual === true )
		{
			toast( 'Sync failed: ' + e.message );
		}
	} finally
	{
		syncing = false;
	}
}

$( '#srvUrl' ).value = srv.url;
$( '#srvTok' ).value = srv.token;
if( srv.token !== '' )
{
	setStatus(
		'Ready. Last sync: ' + ( srv.pull > 0 ? new Date( srv.pull ).toLocaleString() : 'never' )
	);
}

// Changing the server or token resets the markers so the next sync transfers everything.
$( '#srvSave' ).onclick = () =>
{
	const url   = $( '#srvUrl' ).value.trim();
	const token = $( '#srvTok' ).value.trim();
	if( url !== srv.url || token !== srv.token )
	{
		srv.pull = 0;
		srv.push = 0;
	}
	srv.url   = url;
	srv.token = token;
	save( SRV, srv );
	syncNow( true );
};
$( '#srvNow' ).onclick = () => syncNow( true );
window.addEventListener( 'online', autoSync );

// Boot. An unfinished recording left in storage means the app closed or crashed mid-walk.
const crashed = load( CUR, null );
if(
	crashed !== null &&
	crashed.pts !== undefined &&
	crashed.pts.length > 1 &&
	confirm( 'Recover an unfinished recording (' + fmtKm( trackLen( crashed.pts ) ) + ')?' ) === true
)
{
	if( areas.some( ( a ) => a.id === crashed.area ) === false )
	{
		crashed.area = settings.area;
	}
	crashed.updated = Date.now();
	crashed.name    = walkName( crashed.area );
	tracks.push( crashed );
	save( KEY, tracks );
}
localStorage.removeItem( CUR );

refresh();
fitAll();
autoSync();
showVersion();

if( 'serviceWorker' in navigator === true )
{
	navigator.serviceWorker.register( 'sw.js' ).catch( () => undefined );
}
