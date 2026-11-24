'use strict';
// Trailweaver app logic
// Data (JSON in localStorage):
//   track     = { id, name, start, area, updated, visible, favorite, favUpdated, pts }   pts = [[lat, lng, unixSeconds], ...]
//   area      = { id, name, updated }
//   tombstone = { t: 'track' | 'area', id, updated }   a deletion waiting to be synced
// "updated" is a millisecond timestamp bumped on every change; sync uses it for last-write-wins
// "favUpdated" only marks an unsent favorite change; it never goes to the server

const $ = ( selector ) => document.querySelector( selector );

const TRACKS_KEY   = 'trailweaver.tracks.v1';
const CURRENT_KEY  = 'trailweaver.current.v1';
const SETTINGS_KEY = 'trailweaver.settings.v1';
const AREAS_KEY    = 'trailweaver.areas.v1';
const HAS_GEO      = 'geolocation' in navigator;

// localStorage can throw (private mode) or hold bad JSON, so always fall back
const load = ( key, fallback ) =>
{
	try
	{
		const raw = localStorage.getItem( key );

		return ( raw !== null ) ? JSON.parse( raw ) : fallback;
	}
	catch
	{
		return fallback;
	}
};

const save = ( key, value ) =>
{
	try
	{
		localStorage.setItem( key, JSON.stringify( value ) );
	}
	catch
	{
		toast( 'Storage full – export your data' );
	}
};

function toast( message )
{
	const box = $( '#toast' );

	box.textContent = message;

	box.classList.add( 'show' );
	clearTimeout( toast.hideTimer );

	toast.hideTimer = setTimeout( () => box.classList.remove( 'show' ), 2600 );
}

// Haversine distance in meters between [lat, lng] points; extra array elements are ignored
function distanceMeters( from, to )
{
	const earthRadius = 6371000;
	const degToRad    = Math.PI / 180;
	const deltaLat    = ( to[ 0 ] - from[ 0 ] ) * degToRad;
	const deltaLng    = ( to[ 1 ] - from[ 1 ] ) * degToRad;
	const haversine =
		Math.sin( deltaLat / 2 ) ** 2 +
		Math.cos( from[ 0 ] * degToRad ) * Math.cos( to[ 0 ] * degToRad ) * Math.sin( deltaLng / 2 ) ** 2;

	return 2 * earthRadius * Math.asin( Math.sqrt( haversine ) );
}

const trackLength = ( points ) =>
{
	let meters = 0;

	for( let i = 1; i < points.length; i++ )
	{
		meters += distanceMeters( points[ i - 1 ], points[ i ] );
	}

	return meters;
};

const formatKm = ( meters ) => ( meters / 1000 ).toFixed( 2 ) + ' km';

// Clock style time: m:ss, or h:mm:ss from one hour on
const formatClock = ( seconds ) =>
{
	seconds     = Math.max( 0, Math.round( seconds ) );
	const hours = Math.floor( seconds / 3600 );
	const mins  = Math.floor( ( seconds % 3600 ) / 60 );

	return (
		( ( hours > 0 ) ? hours + ':' + String( mins ).padStart( 2, '0' ) : mins ) +
		':' +
		String( seconds % 60 ).padStart( 2, '0' )
	);
};

// Elapsed time as 1h 25m, or 15m under an hour; rounds to the closest minute but never below 1m
const formatDuration = ( seconds ) =>
{
	const totalMins = Math.max( 1, Math.round( seconds / 60 ) );
	const hours     = Math.floor( totalMins / 60 );
	const mins      = totalMins % 60;

	return ( ( hours > 0 ) ? hours + 'h ' : '' ) + mins + 'm';
};

// Seconds from the start tap to the last point; 0 when the track has no usable times
const trackSeconds = ( track ) =>
{
	const lastPoint = track.pts[ track.pts.length - 1 ];

	if( ( lastPoint === undefined ) || ( Number.isFinite( track.start ) === false ) || ( track.start <= 0 ) || ( Number.isFinite( lastPoint[ 2 ] ) === false ) )
	{
		return 0;
	}

	return Math.max( 0, lastPoint[ 2 ] - track.start );
};

// Data saved by older versions may lack "updated"; treat that as 0
const updatedOf = ( item ) => ( ( item.updated === undefined ) ? 0 : item.updated );

// A new walk is named after its area; the date is shown on its own line in the list
const walkName = ( areaId ) =>
{
	const owner = areas.find( ( area ) => ( area.id === areaId ) );

	return ( owner !== undefined ) ? owner.name : 'Walk';
};

let tracks = load( TRACKS_KEY, [] );
let areas  = load( AREAS_KEY, null );

// Defaults for the three path sliders, also used by the "Reset to defaults" button
// They are practical starting points for walking, not measured values; tune them to your terrain
// cell (meters): grid size used to decide that two walks went the same way. Phone GPS typically
//   drifts 3 to 10 m in the open, so 12 m lets repeated walks of one trail share cells, while
//   trails about 25 m or more apart stay separate. Raise it under tree cover or in canyons
// minp (walks): distinct walks that must use a link before it counts as a path. One walk is just a
//   walk, and two can be a coincidence or an out-and-back, so 3 means the route is really reused
// maxacc (meters): fixes with a reported error above this are dropped while recording. Over 25 m
//   is usually a coarse network position or a poor sky view that would draw false jumps, while
//   weaker but usable fixes under foliage are kept
const PATH_DEFAULTS = { cell: 12, minp: 3, maxacc: 25 };

// Stored settings override the defaults; showRaw and area are not path sliders, so they are not reset
let settings = Object.assign
	(
		{ ...PATH_DEFAULTS, showRaw: true, area: null },
		load( SETTINGS_KEY, {} )
	);

let activeWalk = null;
let geoWatchId = null;
let wakeLock   = null;
let statsTimer = null;
let lastEdges  = [];

// Migration for data without areas or timestamps. The fixed 'default' id lets devices share one default area when synced
if( ( Array.isArray( areas ) === false ) || ( areas.length === 0 ) )
{
	areas = [ { id: 'default', name: 'My area', updated: Date.now() } ];

	save( AREAS_KEY, areas );
}
for( const track of tracks )
{
	if( ( track.area === undefined ) || ( track.area === '' ) )
	{
		track.area = areas[ 0 ].id;
	}

	if( ( track.updated === undefined ) || ( track.updated === 0 ) )
	{
		track.updated = Date.now();
	}
}

for( const area of areas )
{
	if( ( area.updated === undefined ) || ( area.updated === 0 ) )
	{
		area.updated = Date.now();
	}
}

if( areas.some( ( area ) => ( area.id === settings.area ) ) === false )
{
	settings.area = areas[ 0 ].id;

	save( SETTINGS_KEY, settings );
}

save( TRACKS_KEY, tracks );

const currentArea = () => areas.find( ( area ) => ( area.id === settings.area ) );
const areaTracks  = () => tracks.filter( ( track ) => ( track.area === settings.area ) );

const map = L.map( 'map', { zoomControl: false } ).setView( [ 20, 0 ], 2 );

// The tile URL pattern is also matched in sw.js for caching
const topoLayer    = L.tileLayer( 'https://tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom   : 17, attribution: '© OpenTopoMap, © OpenStreetMap', } );
const streetsLayer = L.tileLayer( 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom : 19, attribution: '© OpenStreetMap', } );

topoLayer.addTo( map );

L.control.layers( { Topographic : topoLayer, Streets: streetsLayer }, null, { position: 'topright' } ).addTo( map );
L.control.zoom( { position      : 'bottomright' } ).addTo( map );

// refresh() clears and redraws rawLayer and pathLayer; liveLine is the line that grows while recording
const rawLayer       = L.layerGroup().addTo( map );
const pathLayer      = L.layerGroup().addTo( map );
const liveLine       = L.polyline( [], { color: '#b3402a', weight: 4 } ).addTo( map );
const positionMarker = L.circleMarker( [ 0, 0 ],
	{
		radius      : 8,
		color       : '#fff',
		weight      : 3,
		fillColor   : '#2a6fb3',
		fillOpacity : 1,
	} );

// Called for every GPS fix. While recording, drops fixes worse than maxacc and
// fixes closer than minStepMeters (3 to 8 m, half the reported accuracy) to the last saved point
function onPosition( position )
{
	const coords = position.coords;

	$( '#sAcc' ).textContent = Math.round( coords.accuracy ) + ' m';

	const latLng = [ coords.latitude, coords.longitude ];

	positionMarker.setLatLng( latLng );

	if( map.hasLayer( positionMarker ) === false )
	{
		positionMarker.addTo( map );
	}

	if( activeWalk === null )
	{
		return;
	}

	if( coords.accuracy > settings.maxacc )
	{
		return;
	}

	// First usable fix of a recording: offer to switch or create an area if far from this one
	if( ( activeWalk.pts.length === 0 ) && ( activeWalk.checked !== true ) )
	{
		activeWalk.checked = true;

		checkArea( latLng );
	}

	const lastPoint     = activeWalk.pts[ activeWalk.pts.length - 1 ];
	const minStepMeters = Math.max( 3, Math.min( 8, coords.accuracy / 2 ) );

	if( ( lastPoint !== undefined ) && ( distanceMeters( lastPoint, latLng ) < minStepMeters ) )
	{
		return;
	}

	activeWalk.pts.push( [ +latLng[ 0 ].toFixed( 6 ), +latLng[ 1 ].toFixed( 6 ), Math.round( position.timestamp / 1000 ) ] );
	liveLine.addLatLng( latLng );

	if( ( activeWalk.pts.length === 1 ) || ( activeWalk.pts.length % 3 === 0 ) )
	{
		map.panTo( latLng, { animate: true } );
	}

	// Saved every 5th point so an unfinished walk can be recovered after a crash (see boot)
	if( activeWalk.pts.length % 5 === 0 )
	{
		save( CURRENT_KEY, activeWalk );
	}

	updateStats();
}

function onGeoError( error )
{
	toast( ( error.code === 1 ) ? 'Location permission denied' : 'GPS: ' + error.message );
}

// Browsers pause GPS when the screen turns off, so ask to keep it on
async function keepAwake()
{
	try
	{
		wakeLock = await navigator.wakeLock.request( 'screen' );
	}
	catch
	{
		// Optional feature; ignore failures
	}
}

function updateStats()
{
	if( activeWalk === null )
	{
		return;
	}

	$( '#sDist' ).textContent = formatKm( trackLength( activeWalk.pts ) );
	$( '#sTime' ).textContent = formatClock( Date.now() / 1000 - activeWalk.start );
}

function startRecording()
{
	if( HAS_GEO === false )
	{
		return toast( 'Geolocation not supported' );
	}

	activeWalk =
	{
		id      : Date.now(),
		name    : '',
		start   : Math.round( Date.now() / 1000 ),
		visible : true,
		area    : settings.area,
		pts     : [],
	};

	liveLine.setLatLngs( [] );

	geoWatchId = navigator.geolocation.watchPosition( onPosition, onGeoError,
		{
			enableHighAccuracy : true,
			maximumAge         : 0,
			timeout            : 20000,
		} );

	keepAwake();

	statsTimer              = setInterval( updateStats, 1000 );
	$( '#rec' ).textContent = '■ Stop recording';

	$( '#rec' ).classList.add( 'on' );

	$( '#area' ).disabled = true;
}

function stopRecording()
{
	navigator.geolocation.clearWatch( geoWatchId );
	clearInterval( statsTimer );

	if( wakeLock !== null )
	{
		wakeLock.release().catch( () => undefined );
		wakeLock = null;
	}

	if( ( activeWalk !== null ) && ( activeWalk.pts.length >= 2 ) )
	{
		activeWalk.updated = Date.now();

		// Looked up here because checkArea may have switched the area after Start
		activeWalk.name = walkName( activeWalk.area );

		// "checked" is a transient recording flag, not part of the saved track
		delete activeWalk.checked;

		tracks.push( activeWalk );
		save( TRACKS_KEY, tracks );
		toast( 'Saved ' + formatKm( trackLength( activeWalk.pts ) ) );
	}
	else
	{
		toast( 'Too short – discarded' );
	}

	activeWalk = null;

	localStorage.removeItem( CURRENT_KEY );
	liveLine.setLatLngs( [] );

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
	if( activeWalk === null )
	{
		startRecording();
	}
	else
	{
		stopRecording();
	}
};

// Returning to the app releases the wake lock, so request it again
function onVisibility()
{
	if( ( document.visibilityState === 'visible' ) && ( activeWalk !== null ) )
	{
		keepAwake();
	}
}
document.addEventListener( 'visibilitychange', onVisibility );

// Centers on the device position. Works without recording, so it asks for a one-time fix
$( '#locate' ).onclick = () =>
{
	if( HAS_GEO === false )
	{
		return toast( 'Geolocation not supported' );
	}
	toast( 'Locating…' );
	navigator.geolocation.getCurrentPosition(
		( position ) =>
		{
			const latLng = [ position.coords.latitude, position.coords.longitude ];
			positionMarker.setLatLng( latLng );
			if( map.hasLayer( positionMarker ) === false )
			{
				positionMarker.addTo( map );
			}
			map.setView( latLng, Math.max( map.getZoom(), 16 ) );
		},
		onGeoError,
		{ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
	);
};

// The map is resized after the panel changes height, otherwise Leaflet keeps the old size
$( '#toggle' ).onclick = () =>
{
	const hidden = $( '#panel' ).classList.toggle( 'hide' );
	const icon   = $( '#toggleIcon' );
	icon.classList.toggle( 'codicon-menu', hidden );
	icon.classList.toggle( 'codicon-close', ( hidden === false ) );
	setTimeout( () => map.invalidateSize(), 50 );
};

// Pure black layer to save battery on OLED screens; a tap anywhere restores the app
// The theme color is switched too, so the status bar goes black where the browser allows it
// An explanation shows for 10 s, then fades out so the screen is fully black
const themeMeta  = document.querySelector( 'meta[name="theme-color"]' );
const themeColor = themeMeta.content;
let blackTimer   = null;

$( '#blackout' ).onclick = () =>
{
	const status  = ( activeWalk !== null ) ? 'recording your walk' : 'open but not recording';
	const message = $( '#blackMsg' );

	message.textContent = 'Screen blacked out to save battery.\n\nThe phone is still on.\n\nTrailweaver is ' + status + '.\n\nTap anywhere to bring the screen back.';

	message.classList.remove( 'gone' );
	$( '#blackLayer' ).classList.add( 'show' );

	themeMeta.content = '#000000';

	clearTimeout( blackTimer );

	blackTimer = setTimeout( () => message.classList.add( 'gone' ), 10000 );
};

$( '#blackLayer' ).onclick = () =>
{
	clearTimeout( blackTimer );
	$( '#blackLayer' ).classList.remove( 'show' );
	themeMeta.content = themeColor;
};

// 3-point moving average to calm GPS jitter; the end points are kept as they are
function smooth( points )
{
	if( points.length < 3 )
	{
		return points;
	}

	const smoothed = [];

	for( let i = 0; i < points.length; i++ )
	{
		if( ( i === 0 ) || ( i === points.length - 1 ) )
		{
			smoothed.push( points[ i ] );
		}
		else
		{
			smoothed.push
				( [
					( points[ i - 1 ][ 0 ] + points[ i ][ 0 ] + points[ i + 1 ][ 0 ] ) / 3,
					( points[ i - 1 ][ 1 ] + points[ i ][ 1 ] + points[ i + 1 ][ 1 ] ) / 3,
				] );
		}
	}

	return smoothed;
}

// Path detection. A grid of cell-sized squares is laid over the ground and each track is converted
// into the sequence of cells it passes through. Every step between neighboring cells is a "link"
// Links used by at least minPasses DIFFERENT tracks are paths. Walks that stay within about one
// cell of each other share cells, which is what merges meandering walks into one path
// Returns { edges: [{ from, to, passes }], maxPasses, totalMeters } where totalMeters is the total length of the paths
function computePaths( trackList, cellSize, minPasses )
{
	const usable = trackList.filter( ( track ) => ( track.pts.length > 1 ) );

	if( usable.length === 0 )
	{
		return { edges: [], maxPasses: 0, totalMeters: 0 };
	}

	// Local meters around the first point
	const originLat       = usable[ 0 ].pts[ 0 ][ 0 ];
	const originLng       = usable[ 0 ].pts[ 0 ][ 1 ];
	const metersPerDegLng = 111320 * Math.cos( ( originLat * Math.PI ) / 180 );
	const metersPerDegLat = 110540;

	// Link key "cellA|cellB" (sorted, so both directions match) -> number of tracks that used it
	const counts = new Map();
	for( const track of usable )
	{
		const meterPoints  = smooth( track.pts ).map( ( point ) => [ ( point[ 1 ] - originLng ) * metersPerDegLng, ( point[ 0 ] - originLat ) * metersPerDegLat ] );
		const cellSequence = [];
		let previousKey    = null;

		const addCell = ( x, y ) =>
		{
			const cellX = Math.floor( x / cellSize );
			const cellY = Math.floor( y / cellSize );
			const key   = cellX + ',' + cellY;

			if( key !== previousKey )
			{
				cellSequence.push( [ cellX, cellY ] );
				previousKey = key;
			}
		};

		addCell( meterPoints[ 0 ][ 0 ], meterPoints[ 0 ][ 1 ] );

		for( let i = 1; i < meterPoints.length; i++ )
		{
			const deltaX = meterPoints[ i ][ 0 ] - meterPoints[ i - 1 ][ 0 ];
			const deltaY = meterPoints[ i ][ 1 ] - meterPoints[ i - 1 ][ 1 ];
			const gap    = Math.hypot( deltaX, deltaY );

			// A jump over 250 m is a GPS gap: break the sequence instead of drawing a straight line
			if( gap > 250 )
			{
				cellSequence.push( null );
				previousKey = null;

				addCell( meterPoints[ i ][ 0 ], meterPoints[ i ][ 1 ] );

				continue;
			}

			// Half-cell steps so no cell is skipped between distant points
			const steps = Math.max( 1, Math.ceil( gap / ( cellSize / 2 ) ) );

			for( let step = 1; step <= steps; step++ )
			{
				addCell( meterPoints[ i - 1 ][ 0 ] + ( deltaX * step ) / steps, meterPoints[ i - 1 ][ 1 ] + ( deltaY * step ) / steps );
			}
		}
		// Each link counts once per track, so pacing over the same ground is still one walk
		const seen = new Set();

		for( let i = 1; i < cellSequence.length; i++ )
		{
			const fromCell = cellSequence[ i - 1 ];
			const toCell   = cellSequence[ i ];

			if( ( fromCell === null ) || ( toCell === null ) )
			{
				continue;
			}

			const fromKey = fromCell.join( ',' );
			const toKey   = toCell.join( ',' );
			const linkKey = ( fromKey < toKey ) ? fromKey + '|' + toKey : toKey + '|' + fromKey;

			if( seen.has( linkKey ) === false )
			{
				seen.add( linkKey );

				const previousCount = counts.get( linkKey );

				counts.set( linkKey, ( previousCount === undefined ) ? 1 : previousCount + 1 );
			}
		}
	}
	const cellToLatLng = ( cell ) => [ originLat + ( ( cell[ 1 ] + 0.5 ) * cellSize ) / metersPerDegLat, originLng + ( ( cell[ 0 ] + 0.5 ) * cellSize ) / metersPerDegLng ];
	const edges        = [];

	let maxPasses   = 0;
	let totalMeters = 0;

	for( const [ linkKey, passes ] of counts )
	{
		if( passes < minPasses )
		{
			continue;
		}

		const [ fromCell, toCell ] = linkKey.split( '|' ).map( ( text ) => text.split( ',' ).map( Number ) );
		const fromLatLng           = cellToLatLng( fromCell );
		const toLatLng             = cellToLatLng( toCell );

		edges.push( { from: fromLatLng, to: toLatLng, passes: passes } );

		maxPasses = Math.max( maxPasses, passes );

		totalMeters += distanceMeters( fromLatLng, toLatLng );
	}

	return { edges: edges, maxPasses: maxPasses, totalMeters: totalMeters };
}

// Yellow (few passes) to red (many passes)
const rampColor = ( passes, maxPasses ) =>
{
	const ratio = ( maxPasses <= settings.minp ) ? 1 : ( passes - settings.minp ) / ( maxPasses - settings.minp );

	return `hsl(${50 - 50 * ratio},90%,${52 - 8 * ratio}%)`;
};

// Single redraw entry point; call it after any data change
function refresh()
{
	rawLayer.clearLayers();
	pathLayer.clearLayers();

	const visibleTracks = areaTracks().filter( ( track ) => ( track.visible !== false ) );

	if( settings.showRaw === true )
	{
		visibleTracks.forEach( ( track ) =>
			L.polyline
				(
					track.pts.map( ( point ) => [ point[ 0 ], point[ 1 ] ] ),
					{ color: '#3a6ea5', weight: 4, opacity: 0.85 }
				).addTo( rawLayer )
		);
	}

	const paths = computePaths( visibleTracks, +settings.cell, +settings.minp );
	lastEdges   = paths.edges;

	for( const edge of paths.edges )
	{
		L.polyline( [ edge.from, edge.to ],
			{
				color   : rampColor( edge.passes, paths.maxPasses ),
				weight  : 3 + Math.min( 6, edge.passes - settings.minp ),
				opacity : 0.95,
				lineCap : 'round',
			} )
			.bindTooltip( edge.passes + ' passes' )
			.addTo( pathLayer );
	}

	$( '#sPaths' ).textContent = ( paths.totalMeters / 1000 ).toFixed( 2 );

	renderAreas();
	renderList();
}

// Outlined heart when off, filled when on; always red through the ic-fav color
const setFavoriteIcon = ( button, isOn ) =>
{
	button.firstChild.className = 'codicon codicon-heart' + ( ( isOn === true ) ? '-filled' : '' ) + ' ico ic-fav';

	button.setAttribute( 'aria-pressed', isOn );
};

// Icon-only button. icon is a codicon name, tone picks the color class (ic-<tone> in styles.css)
const iconButton = ( icon, tone, label ) =>
{
	const button = document.createElement( 'button' );
	const glyph  = document.createElement( 'span' );

	glyph.className  = 'codicon codicon-' + icon + ' ico ic-' + tone;
	button.className = 'sm';
	button.title     = label;

	button.setAttribute( 'aria-label', label );
	button.appendChild( glyph );
	return button;
};

// Move dialog: one radio per other area. Tapping an area moves the track at once; Cancel, the
// backdrop or the Android back button closes it without changes
const moveDialog = document.createElement( 'dialog' );

moveDialog.className = 'moveDlg';

moveDialog.onclick = ( event ) =>
{
	if( event.target === moveDialog )
	{
		moveDialog.close();
	}
};

document.body.appendChild( moveDialog );

const moveTrack = ( track, targetArea ) =>
{
	track.area    = targetArea.id;
	track.updated = Date.now();

	autoSync();
	save( TRACKS_KEY, tracks );
	refresh();
	toast( 'Moved to ' + targetArea.name );
};

const pickArea = ( track, otherAreas ) =>
{
	const body     = document.createElement( 'div' );
	body.className = 'moveBody';

	const title       = document.createElement( 'p' );
	title.className   = 'moveTitle';
	title.textContent = 'Move "' + track.name + '" to:';

	const list     = document.createElement( 'div' );
	list.className = 'moveList';

	for( const area of otherAreas )
	{
		const row = document.createElement( 'label' );

		row.className = 'moveOpt';

		const radio = document.createElement( 'input' );

		radio.type = 'radio';
		radio.name = 'moveArea';

		const text       = document.createElement( 'span' );
		text.textContent = area.name + ' (' + tracks.filter( ( other ) => ( other.area === area.id ) ).length + ')';

		radio.onchange = () =>
		{
			moveDialog.close();
			moveTrack( track, area );
		};

		row.append( radio, text );
		list.appendChild( row );
	}

	const cancel       = document.createElement( 'button' );
	cancel.className   = 'sm moveCancel';
	cancel.textContent = 'Cancel';
	cancel.onclick     = () => moveDialog.close();

	body.append( title, list, cancel );
	moveDialog.replaceChildren( body );
	moveDialog.showModal();
};

function renderList()
{
	const listElement = $( '#list' );

	if( areaTracks().length === 0 )
	{
		listElement.innerHTML = '<p class="hint">No tracks in this area yet. Press Start, walk, then Stop. Paths appear in orange→red where several walks overlap.</p>';
		return;
	}

	listElement.innerHTML = '';
	const newestFirst     = areaTracks().slice().reverse();

	for( const track of newestFirst )
	{
		const row     = document.createElement( 'div' );
		row.className = 'track';

		const checkbox   = document.createElement( 'input' );
		checkbox.type    = 'checkbox';
		checkbox.checked = ( track.visible !== false );

		checkbox.setAttribute( 'aria-label', 'Show ' + track.name + ' on map' );

		checkbox.className = 'track-check';

		const info     = document.createElement( 'div' );
		info.className = 'track-info';

		const nameLine       = document.createElement( 'div' );
		nameLine.className   = 'track-name';
		nameLine.textContent = track.name;

		const dateLine     = document.createElement( 'div' );
		dateLine.className = 'track-date';

		if( ( Number.isFinite( track.start ) === true ) && ( track.start > 0 ) )
		{
			dateLine.textContent = new Date( track.start * 1000 ).toLocaleString( [], { dateStyle: 'short', timeStyle: 'short' } );
		}

		const metaLine     = document.createElement( 'div' );
		metaLine.className = 'track-meta';

		const seconds        = trackSeconds( track );
		metaLine.textContent = formatKm( trackLength( track.pts ) ) + ' · ' + track.pts.length + ' pts' + ( ( seconds > 0 ) ? ' · ' + formatDuration( seconds ) : '' );

		info.append( nameLine, dateLine, metaLine );

		const actions     = document.createElement( 'div' );
		actions.className = 'track-actions';

		const zoomButton     = iconButton( 'location', 'zoom', 'Find track on map' );
		const moveButton     = iconButton( 'move', 'move', 'Move track to another area' );
		const renameButton   = iconButton( 'edit', 'rename', 'Rename track' );
		const deleteButton   = iconButton( 'trash', 'delete', 'Delete track' );
		const favoriteButton = iconButton( 'heart', 'fav', 'Favorite' );

		setFavoriteIcon( favoriteButton, ( track.favorite === true ) );

		actions.append( zoomButton, moveButton, renameButton, deleteButton, favoriteButton );
		row.append( checkbox, info, actions );

		moveButton.onclick = () =>
		{
			const otherAreas = areas.filter( ( area ) => ( area.id !== settings.area ) );

			if( otherAreas.length === 0 )
			{
				return toast( 'Create another area first' );
			}

			pickArea( track, otherAreas );
		};

		renameButton.onclick = () =>
		{
			const newName = prompt( 'Rename track:', track.name );

			if( ( newName !== null ) && ( newName.trim() !== '' ) )
			{
				track.name    = newName.trim();
				track.updated = Date.now();

				save( TRACKS_KEY, tracks );
				refresh();
				autoSync();
			}
		};

		checkbox.onchange = () =>
		{
			track.visible = checkbox.checked;

			save( TRACKS_KEY, tracks );
			refresh();
		};

		favoriteButton.onclick = () =>
		{
			track.favorite   = ( track.favorite !== true );
			track.favUpdated = Date.now();

			setFavoriteIcon( favoriteButton, track.favorite );
			save( TRACKS_KEY, tracks );
			autoSync();
		};

		zoomButton.onclick = () => map.fitBounds( L.latLngBounds( track.pts.map( ( point ) => [ point[ 0 ], point[ 1 ] ] ) ), { padding: [ 30, 30 ] } );

		deleteButton.onclick = () =>
		{
			if( confirm( 'Delete this track?' ) === true )
			{
				tombstone( 'track', track.id );

				tracks = tracks.filter( ( other ) => ( other !== track ) );

				save( TRACKS_KEY, tracks );
				refresh();
				autoSync();
			}
		};

		listElement.appendChild( row );
	}
}

// Sets the visible flag of every track in this area; "rule" decides the value per track
const checkTracks = ( rule ) =>
{
	for( const track of areaTracks() )
	{
		track.visible = rule( track );
	}

	save( TRACKS_KEY, tracks );
	refresh();
};

$( '#chkAll' ).onclick  = () => checkTracks( () => true );
$( '#chkNone' ).onclick = () => checkTracks( () => false );
$( '#chkFav' ).onclick  = () => checkTracks( ( track ) => ( track.visible !== false ) || ( track.favorite === true ) );

// Data tab footer: the version comes from SHELL in sw.js (the only place to bump it)
// Two versions listed means an update is waiting, ie, a version that differs from the expected one means a stale file
const showVersion = async () =>
{
	let versionText = 'none';
	try
	{
		const cacheNames = ( await caches.keys() ).filter( ( cacheName ) => cacheName.startsWith( 'trailweaver-shell-' ) );
		versionText      = ( cacheNames.length > 0 ) ? cacheNames.map( ( cacheName ) => cacheName.slice( 18 ) ).join( ', ' ) : 'none';
	}
	catch
	{
		versionText = 'unavailable';
	}

	$( '#ver' ).textContent = 'Version: ' + versionText;
};

// Fit the map to the current area, or to the device position if the area has no tracks
function fitAll()
{
	const allPoints = areaTracks().flatMap( ( track ) => track.pts.map( ( point ) => [ point[ 0 ], point[ 1 ] ] ) );

	if( allPoints.length > 0 )
	{
		map.fitBounds( L.latLngBounds( allPoints ), { padding: [ 30, 30 ] } );
	}
	else if( HAS_GEO === true )
	{
		navigator.geolocation.getCurrentPosition
			(
				( position ) => map.setView( [ position.coords.latitude, position.coords.longitude ], 15 ),
				() => undefined,
				{ timeout: 8000 }
			);
	}
}

// The value label follows the slider while dragging; save and redraw only on release
function bindSetting( sliderId, key, labelId, unit )
{
	const slider = $( '#' + sliderId );
	const label  = $( '#' + labelId );

	slider.value      = settings[ key ];
	label.textContent = settings[ key ] + unit;
	slider.oninput    = () =>
	{
		settings[ key ]   = +slider.value;
		label.textContent = slider.value + unit;
	};

	slider.onchange = () =>
	{
		save( SETTINGS_KEY, settings );
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
	save( SETTINGS_KEY, settings );
	refresh();
	toast( 'Path settings reset' );
};

$( '#showRaw' ).checked  = settings.showRaw;
$( '#showRaw' ).onchange = ( event ) =>
{
	settings.showRaw = event.target.checked;

	save( SETTINGS_KEY, settings );
	refresh();
};

// Tab button data-t="x" shows the element with id "t-x"
for( const tabButton of document.querySelectorAll( '.tabs button' ) )
{
	tabButton.onclick = () =>
	{
		for( const element of document.querySelectorAll( '.tabs button,.tab' ) )
		{
			element.classList.remove( 'active' );
		}

		tabButton.classList.add( 'active' );

		$( '#t-' + tabButton.dataset.t ).classList.add( 'active' );
	};
}

function download( fileName, text, type )
{
	const link    = document.createElement( 'a' );
	link.href     = URL.createObjectURL( new Blob( [ text ], { type: type } ) );
	link.download = fileName;

	link.click();
	setTimeout( () => URL.revokeObjectURL( link.href ), 1000 );
}

// Each track gets <type>trailweaver:AreaName</type> so importing the file restores its area
const exportGpx = ( trackList, fileName ) =>
{
	if( trackList.length === 0 )
	{
		return toast( 'Nothing to export' );
	}

	const escapeXml = ( text ) => String( text ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' );
	const trackXml  = [];

	for( const track of trackList )
	{
		const owner    = areas.find( ( area ) => ( area.id === track.area ) );
		const areaName = ( owner !== undefined ) ? owner.name : '';

		let segment = '';

		for( const point of track.pts )
		{
			const hasTime = ( Number.isFinite( point[ 2 ] ) === true ) && ( point[ 2 ] !== 0 );
			const timeTag = ( hasTime === true ) ? `<time>${new Date( point[ 2 ] * 1000 ).toISOString()}</time>` : '';

			segment += `<trkpt lat = "${point[ 0 ]}" lon="${point[ 1 ]}">${timeTag}</trkpt>`;
		}
		trackXml.push( `<trk><name>${escapeXml( track.name )}</name><type>trailweaver:${escapeXml( areaName )}</type><trkseg>${segment}</trkseg></trk>` );
	}

	const body = trackXml.join( '\n' );

	download
		(
			fileName,
			`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Trailweaver" xmlns="http://www.topografix.com/GPX/1/1">\n${body}\n</gpx>`,
			'application/gpx+xml'
		);
};

const safeName = () => currentArea().name.replace( /[^\p{L}\p{N}]+/gu, '_' );

$( '#exGpx' ).onclick = () => exportGpx( areaTracks(), 'trailweaver-' + safeName() + '.gpx' );
$( '#exAll' ).onclick = () => exportGpx( tracks, 'trailweaver-all-areas.gpx' );

// GeoJSON coordinates are [longitude, latitude], the reverse of the internal [lat, lng]
$( '#exGeo' ).onclick = () =>
{
	if( lastEdges.length === 0 )
	{
		return toast( 'No paths yet – lower the pass threshold?' );
	}

	const features = lastEdges.map( ( edge ) =>
	( {
		type       : 'Feature',
		properties : { passes: edge.passes },
		geometry   :
		{
			type: 'LineString',
			coordinates: [
				[ edge.from[ 1 ], edge.from[ 0 ] ],
				[ edge.to[ 1 ], edge.to[ 0 ] ],
			],
		},
	} ) );

	const collection = { type: 'FeatureCollection', features: features };

	download
		(
			'trailweaver-paths-' + safeName() + '.geojson',
			JSON.stringify( collection ),
			'application/geo+json'
		);
};

$( '#imp' ).onclick = () => $( '#file' ).click();

$( '#file' ).onchange = async ( event ) =>
{
	let added = 0;
	for( const file of event.target.files )
	{
		const doc        = new DOMParser().parseFromString( await file.text(), 'text/xml' );
		const trackNodes = doc.querySelectorAll( 'trk' );

		for( let i = 0; i < trackNodes.length; i++ )
		{
			const trackNode = trackNodes[ i ];
			const pts       = [];

			for( const pointNode of trackNode.querySelectorAll( 'trkpt' ) )
			{
				const timeNode = pointNode.querySelector( 'time' );
				const seconds  = ( timeNode !== null ) ? Math.round( Date.parse( timeNode.textContent ) / 1000 ) : 0;

				pts.push( [ +pointNode.getAttribute( 'lat' ), +pointNode.getAttribute( 'lon' ), seconds ] );
			}

			if( pts.length > 1 )
			{
				// Only our own "trailweaver:" marker may create areas; other apps use <type> for things like "hiking"
				const typeNode = trackNode.querySelector( 'type' );
				const typeText = ( typeNode !== null ) ? typeNode.textContent.trim()                       : '';
				const areaName = ( typeText.startsWith( 'trailweaver:' ) === true ) ? typeText.slice( 12 ) : '';

				let importArea;

				if( areaName !== '' )
				{
					importArea = areas.find( ( area ) => ( area.name === areaName ) );

					if( importArea === undefined )
					{
						importArea = { id: 'a' + Date.now() + '_' + added, name: areaName, updated: Date.now() };
						areas.push( importArea );
					}
				}

				const nameNode = trackNode.querySelector( 'name' );
				let trackName  = file.name;

				if( ( nameNode !== null ) && ( nameNode.textContent !== '' ) )
				{
					trackName = nameNode.textContent;
				}

				// "+ added" keeps ids unique within one import
				const track =
				{
					area    : ( importArea !== undefined ) ? importArea.id : settings.area,
					updated : Date.now(),
					id      : Date.now() + added,
					name    : trackName + ( ( i > 0 ) ? ' #' + ( i + 1 ) : '' ),
					start   : pts[ 0 ][ 2 ],
					visible : true,
					pts     : pts,
				};

				tracks.push( track );

				added++;
			}
		}
	}
	event.target.value = '';

	save( TRACKS_KEY, tracks );
	save( AREAS_KEY, areas );
	refresh();
	fitAll();
	autoSync();
	toast( added + ' track(s) imported' );
};

$( '#wipe' ).onclick = () =>
{
	const where = ( server.token !== '' ) ? ', here and on the server' : ' on this device';

	if( confirm( 'Delete ALL tracks in ALL areas' + where + '?' ) === true )
	{
		tracks.forEach( ( track ) => tombstone( 'track', track.id ) );
		tracks = [];
		save( TRACKS_KEY, tracks );
		refresh();
		autoSync();
	}
};

// Adds 7 synthetic walks along one loose route; each wobbles randomly around it, like a person wandering
$( '#demo' ).onclick = () =>
{
	const center         = map.getCenter();
	const origin         = [ center.lat, center.lng ];
	const degPerMeterLat = 1 / 110540;
	const degPerMeterLng = 1 / ( 111320 * Math.cos( ( origin[ 0 ] * Math.PI ) / 180 ) );
	const route =
		[
			[ -300, -200 ],
			[ -100, -50 ],
			[ 80, 40 ],
			[ 250, 220 ],
			[ 400, 150 ],
		];

	for( let walkIndex = 0; walkIndex < 7; walkIndex++ )
	{
		const pts = [];
		let drift = [ 0, 0 ];
		let time  = Math.round( Date.now() / 1000 ) - 86400 * ( 7 - walkIndex );

		for( let i = 1; i < route.length; i++ )
		{
			const legStart = route[ i - 1 ];
			const legEnd   = route[ i ];
			const samples  = Math.round( Math.hypot( legEnd[ 0 ] - legStart[ 0 ], legEnd[ 1 ] - legStart[ 1 ] ) / 5 );

			for( let sample = 0; sample < samples; sample++ )
			{
				drift =
					[
						drift[ 0 ] * 0.93 + ( Math.random() - 0.5 ) * 9,
						drift[ 1 ] * 0.93 + ( Math.random() - 0.5 ) * 9,
					];

				const x = legStart[ 0 ] + ( ( legEnd[ 0 ] - legStart[ 0 ] ) * sample ) / samples + drift[ 0 ];
				const y = legStart[ 1 ] + ( ( legEnd[ 1 ] - legStart[ 1 ] ) * sample ) / samples + drift[ 1 ];

				time += 4;

				pts.push( [ +( origin[ 0 ] + y * degPerMeterLat ).toFixed( 6 ), +( origin[ 1 ] + x * degPerMeterLng ).toFixed( 6 ), time ] );
			}
		}
		const track =
		{
			area    : settings.area,
			updated : Date.now(),
			id      : Date.now() + walkIndex,
			name    : 'Demo walk ' + ( walkIndex + 1 ),
			start   : pts[ 0 ][ 2 ],
			visible : true,
			pts     : pts,
		};

		tracks.push( track );
	}
	save( TRACKS_KEY, tracks );
	refresh();
	fitAll();
	toast( 'Demo walks added – paths emerge where they overlap' );
};

function renderAreas()
{
	const select     = $( '#area' );
	select.innerHTML = '';

	for( const area of areas )
	{
		const option       = document.createElement( 'option' );
		option.value       = area.id;
		option.textContent = area.name + ' (' + tracks.filter( ( track ) => ( track.area === area.id ) ).length + ')';

		if( area.id === settings.area )
		{
			option.selected = true;
		}
		select.appendChild( option );
	}
}

// A recording in progress follows into the new area
function setArea( areaId )
{
	settings.area = areaId;
	save( SETTINGS_KEY, settings );

	if( activeWalk !== null )
	{
		activeWalk.area = areaId;
	}

	refresh();
	fitAll();
}

function newArea( name )
{
	const area = { id: 'a' + Date.now(), name: name.trim(), updated: Date.now() };

	areas.push( area );
	save( AREAS_KEY, areas );
	setArea( area.id );
	autoSync();
}

// Distance in meters to the nearest point of the given tracks (checks every 3rd point)
const nearestMeters = ( trackList, latLng ) =>
{
	let best = Infinity;

	for( const track of trackList )
	{
		for( let i = 0; i < track.pts.length; i += 3 )
		{
			const meters = distanceMeters( latLng, track.pts[ i ] );

			if( meters < best )
			{
				best = meters;
			}
		}
	}
	return best;
};

// Runs at the first fix of a recording. More than 3 km from this area's tracks: offer the nearest
// other area within 1.5 km, otherwise offer a new area. Declining keeps the current area
function checkArea( latLng )
{
	const ownTracks = areaTracks();

	if( ( ownTracks.length === 0 ) || ( nearestMeters( ownTracks, latLng ) < 3000 ) )
	{
		return;
	}

	const otherAreas = areas.filter( ( area ) => ( area.id !== settings.area ) );
	const distances  = otherAreas.map( ( area ) =>
	( {
		area: area,
		meters: nearestMeters(
			tracks.filter( ( track ) => ( track.area === area.id ) ),
			latLng
		),
	} ) );

	const nearby = distances.filter( ( entry ) => ( entry.meters < 1500 ) ).sort( ( first, second ) => first.meters - second.meters );

	if( nearby.length > 0 )
	{
		if(
			confirm
				(
					'You are near "' +
					nearby[ 0 ].area.name +
					'". Record there instead of "' +
					currentArea().name +
					'"?'
				) === true
		)
		{
			setArea( nearby[ 0 ].area.id );
		}
		return;
	}

	if( confirm( 'You are far from "' + currentArea().name + '". Start a new area here?' ) === true )
	{
		const newName = prompt( 'Name for the new area:', 'New area' );

		if( ( newName !== null ) && ( newName.trim() !== '' ) )
		{
			newArea( newName );
		}
	}
}

$( '#area' ).onchange = ( event ) => setArea( event.target.value );

$( '#aNew' ).onclick = () =>
{
	const newName = prompt( 'Name for the new area:' );

	if( ( newName !== null ) && ( newName.trim() !== '' ) )
	{
		newArea( newName );
	}
};

$( '#aRen' ).onclick = () =>
{
	const newName = prompt( 'Rename area:', currentArea().name );

	if( ( newName !== null ) && ( newName.trim() !== '' ) )
	{
		currentArea().name    = newName.trim();
		currentArea().updated = Date.now();
		save( AREAS_KEY, areas );
		renderAreas();
		autoSync();
	}
};

// Deleting an area also deletes its tracks; tombstones let other devices do the same
$( '#aDel' ).onclick = () =>
{
	if( areas.length < 2 )
	{
		return toast( 'Keep at least one area' );
	}
	const trackCount = areaTracks().length;

	if( confirm( 'Delete "' + currentArea().name + '" and its ' + trackCount + ' track(s)?' ) === true )
	{
		const areaId = settings.area;

		tracks.filter( ( track ) => ( track.area === areaId ) ).forEach( ( track ) => tombstone( 'track', track.id ) );
		tombstone( 'area', areaId );

		tracks = tracks.filter( ( track ) => ( track.area !== areaId ) );
		areas  = areas.filter( ( area ) => ( area.id !== areaId ) );

		save( TRACKS_KEY, tracks );
		save( AREAS_KEY, areas );
		setArea( areas[ 0 ].id );
		autoSync();
	}
};

// Optional sync with api.php; it does nothing until a token is entered. Each sync uploads items
// changed since the last one, then merges what the server changed (newer "updated" wins)
// Deletions travel as tombstones because a deleted item no longer exists to upload
const SERVER_KEY     = 'trailweaver.server.v1';
const TOMBSTONES_KEY = 'trailweaver.tomb.v1';

// pull: server clock (ms) from the last sync, sent back as "since"
// push: device clock (ms) when the last sync started; items updated after it are unsent
let server     = Object.assign( { url: '', token: '', pull: 0, push: 0 }, load( SERVER_KEY, {} ) );
let tombstones = load( TOMBSTONES_KEY, [] );
let isSyncing  = false;

// Device ids are numbers, server ids are strings
const sameId    = ( first, second ) => ( String( first ) === String( second ) );
const serverUrl = () => ( server.url.trim() !== '' ) ? server.url.trim() : new URL( 'api.php', location.href ).href;

const setStatus = ( message ) =>
{
	$( '#srvStatus' ).textContent = message;
};

// The kind is stored under the key "t", which api.php reads
function tombstone( kind, id )
{
	tombstones.push( { t: kind, id: String( id ), updated: Date.now() } );
	save( TOMBSTONES_KEY, tombstones );
}

const autoSync = () =>
{
	if( server.token !== '' )
	{
		syncNow( false );
	}
};

// "manual" is true when a button started the sync; only then are results shown as toasts
async function syncNow( manual )
{
	if( server.token === '' )
	{
		if( manual === true )
		{
			toast( 'Enter your secret token first' );
		}

		return;
	}

	if( isSyncing === true )
	{
		return;
	}

	// Never sync mid-recording
	if( activeWalk !== null )
	{
		if( manual === true )
		{
			toast( 'Stop recording first, it syncs automatically afterwards' );
		}
		return;
	}

	isSyncing = true;

	setStatus( 'Syncing…' );

	// Taken before collecting changes, so anything modified during the sync is sent next time
	const startedAt = Date.now() - 1;

	try
	{
		const changedAreas     = areas.filter( ( area ) => updatedOf( area ) > server.push );
		const changedTracks    = tracks.filter( ( track ) => updatedOf( track ) > server.push );
		const deletions        = tombstones.filter( ( deletion ) => ( deletion.updated > server.push ) );
		const changedFavorites = tracks.filter( ( track ) => ( ( track.favUpdated === undefined ) ? 0 : track.favUpdated ) > server.push );
		const toPayload        = ( track ) =>
		( {
			id      : String( track.id ),
			area    : track.area,
			name    : track.name,
			start   : ( Number.isFinite( track.start ) === true ) ? track.start : 0,
			updated : track.updated,
			pts     : track.pts,
		} );

		// Upload 20 tracks per request. Only the last request asks for the server's changes (since is
		// set); earlier ones send since: null, meaning "store only"
		const chunks = [];

		for( let i = 0; i < changedTracks.length; i += 20 )
		{
			chunks.push( changedTracks.slice( i, i + 20 ) );
		}
		if( chunks.length === 0 )
		{
			chunks.push( [] );
		}

		let reply;

		for( let i = 0; i < chunks.length; i++ )
		{
			const isFirst = ( i === 0 );
			const isLast  = ( i === ( chunks.length - 1 ) );
			const body =
			{
				since   : ( isLast === true ) ? server.pull : null,
				areas   : ( isFirst === true ) ? changedAreas : [],
				deleted : ( isFirst === true ) ? deletions : [],
				tracks  : chunks[ i ].map( toPayload ),
				favs    : ( isLast === true ) ? changedFavorites.map( ( track ) => ( { id: String( track.id ), favorite: ( track.favorite === true ) } ) ) : [],
			};
			const httpResponse = await fetch( serverUrl(),
				{
					method  : 'POST',
					headers : { 'Content-Type': 'application/json', 'X-TW-Token': server.token },
					body    : JSON.stringify( body ),
				} );

			if( httpResponse.ok === false )
			{
				let errorMessage = 'server error ' + httpResponse.status;
				try
				{
					const errorBody = await httpResponse.json();

					if( errorBody.error !== undefined )
					{
						errorMessage = errorBody.error;
					}
				}
				catch
				{
					// The error body was not JSON
				}
				throw new Error( errorMessage );
			}

			reply = await httpResponse.json();
		}
		// Merge the server's changes. A deletion is ignored if the local copy is newer, and the last area is never removed
		let changed       = false;
		const serverAreas = ( reply.areas === undefined ) ? [] : reply.areas;

		for( const serverArea of serverAreas )
		{
			const index = areas.findIndex( ( area ) => sameId( area.id, serverArea.id ) );

			if( serverArea.deleted === true )
			{
				if( ( index >= 0 ) && ( areas.length > 1 ) && ( updatedOf( areas[ index ] ) <= serverArea.updated ) )
				{
					areas.splice( index, 1 );

					changed = true;
				}
			}
			else if( index < 0 )
			{
				areas.push( { id: serverArea.id, name: serverArea.name, updated: serverArea.updated } );

				changed = true;
			}
			else if( serverArea.updated > updatedOf( areas[ index ] ) )
			{
				areas[ index ].name    = serverArea.name;
				areas[ index ].updated = serverArea.updated;
				changed                = true;
			}
		}
		const serverTracks = ( reply.tracks === undefined ) ? [] : reply.tracks;

		for( const serverTrack of serverTracks )
		{
			const index = tracks.findIndex( ( track ) => sameId( track.id, serverTrack.id ) );

			if( serverTrack.deleted === true )
			{
				if( ( index >= 0 ) && ( updatedOf( tracks[ index ] ) <= serverTrack.updated ) )
				{
					tracks.splice( index, 1 );

					changed = true;
				}
			}
			else if( index < 0 )
			{
				tracks.push
					( {
						id      : serverTrack.id,
						area    : serverTrack.area,
						name    : serverTrack.name,
						start   : serverTrack.start,
						visible : true,
						updated : serverTrack.updated,
						pts     : serverTrack.pts,
					} );

				changed = true;
			}
			else if( serverTrack.updated > updatedOf( tracks[ index ] ) )
			{
				// Points never change after recording, so only these fields are updated
				Object.assign( tracks[ index ], { area: serverTrack.area, name: serverTrack.name, updated: serverTrack.updated } );

				changed = true;
			}
		}

		// The server returns the ids of all favorites; the flags follow it, except ones toggled during this sync
		if( reply.favs !== undefined )
		{
			const serverFavorites = new Set( reply.favs.map( String ) );

			for( const track of tracks )
			{
				if( ( ( track.favUpdated === undefined ) ? 0 : track.favUpdated ) > startedAt )
				{
					continue;
				}

				const isFavorite = serverFavorites.has( String( track.id ) );

				if( ( track.favorite === true ) !== isFavorite )
				{
					track.favorite = isFavorite;

					changed = true;
				}
			}
		}

		// Tracks whose area was deleted elsewhere move to the first area
		for( const track of tracks )
		{
			if( areas.some( ( area ) => sameId( area.id, track.area ) ) === false )
			{
				track.area = areas[ 0 ].id;
			}
		}

		if( areas.some( ( area ) => ( area.id === settings.area ) ) === false )
		{
			settings.area = areas[ 0 ].id;

			save( SETTINGS_KEY, settings );
		}
		server.pull = reply.now;
		server.push = startedAt;

		save( SERVER_KEY, server );
		save( TRACKS_KEY, tracks );
		save( AREAS_KEY, areas );

		if( changed === true )
		{
			refresh();
		}

		setStatus( 'Synced ' + new Date().toLocaleTimeString() + ' · sent ' + changedTracks.length + ' track(s)' );

		if( manual === true )
		{
			toast( 'Synced' );
		}
	}
	catch( error )
	{
		setStatus( 'Sync failed: ' + error.message );

		if( manual === true )
		{
			toast( 'Sync failed: ' + error.message );
		}
	}
	finally
	{
		isSyncing = false;
	}
}

$( '#srvUrl' ).value = server.url;
$( '#srvTok' ).value = server.token;

if( server.token !== '' )
{
	setStatus( 'Ready. Last sync: ' + ( ( server.pull > 0 ) ? new Date( server.pull ).toLocaleString() : 'never' ) );
}

// Changing the server or token resets the markers so the next sync transfers everything
$( '#srvSave' ).onclick = () =>
{
	const url   = $( '#srvUrl' ).value.trim();
	const token = $( '#srvTok' ).value.trim();

	if( ( url !== server.url ) || ( token !== server.token ) )
	{
		server.pull = 0;
		server.push = 0;
	}
	server.url   = url;
	server.token = token;

	save( SERVER_KEY, server );
	syncNow( true );
};

$( '#srvNow' ).onclick = () => syncNow( true );

window.addEventListener( 'online', autoSync );

// Boot. An unfinished recording left in storage means the app closed or crashed mid-walk
const unfinishedWalk = load( CURRENT_KEY, null );
if( ( unfinishedWalk !== null )
	&& ( unfinishedWalk.pts !== undefined )
	&& ( unfinishedWalk.pts.length > 1 )
	&& ( confirm( 'Recover an unfinished recording (' + formatKm( trackLength( unfinishedWalk.pts ) ) + ')?' ) === true )
)
{
	if( areas.some( ( area ) => ( area.id === unfinishedWalk.area ) ) === false )
	{
		unfinishedWalk.area = settings.area;
	}

	unfinishedWalk.updated = Date.now();
	unfinishedWalk.name    = walkName( unfinishedWalk.area );

	tracks.push( unfinishedWalk );
	save( TRACKS_KEY, tracks );
}
localStorage.removeItem( CURRENT_KEY );

refresh();
fitAll();
autoSync();
showVersion();

if( ( 'serviceWorker' in navigator ) === true )
{
	navigator.serviceWorker.register( 'sw.js' ).catch( () => undefined );
}