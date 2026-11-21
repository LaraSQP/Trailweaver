'use strict';
// Service worker: offline app shell plus cached map tiles. Stale-while-revalidate, so a new
// version of the app shows up on the second launch after an upload.

// Bump SHELL's version to make activate discard old caches.
const SHELL = 'trailweaver-shell-v3';
const TILES = 'trailweaver-tiles-v1';

const ASSETS =
	[
		'./',
		'./index.html',
		'./app.js',
		'./manifest.json',
		'./icon.svg',
		'./styles.css',
		'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
		'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
	];

// allSettled: one failed download (for example the CDN while offline) must not abort the install.
self.addEventListener( 'install', ( e ) =>
{
	e.waitUntil(
		caches
			.open( SHELL )
			.then( ( c ) => Promise.allSettled( ASSETS.map( ( a ) => c.add( a ) ) ) )
			.then( () => self.skipWaiting() )
	);
} );

self.addEventListener( 'activate', ( e ) =>
{
	e.waitUntil(
		caches
			.keys()
			.then( ( keys ) =>
				Promise.all(
					keys
						.filter( ( k ) => [ SHELL, TILES ].includes( k ) === false )
						.map( ( k ) => caches.delete( k ) )
				)
			)
			.then( () => self.clients.claim() )
	);
} );

self.addEventListener( 'fetch', ( e ) =>
{
	// The sync upload is a POST and must always reach the network.
	if( e.request.method !== 'GET' )
	{
		return;
	}
	const isTile = /tile\.(opentopomap|openstreetmap)\.org/.test( e.request.url );
	e.respondWith(
		( async () =>
		{
			const cache = await caches.open( isTile === true ? TILES : SHELL );
			const hit   = await cache.match( e.request );
			const net   = fetch( e.request )
				.then( ( r ) =>
				{
					// Opaque responses (cross-origin tiles and scripts) cannot be inspected but can be cached.
					if( r !== undefined && ( r.ok === true || r.type === 'opaque' ) )
					{
						cache.put( e.request, r.clone() );
						// Tile cache limit: drop the oldest entry above 1500.
						if( isTile === true )
						{
							cache.keys().then( ( k ) =>
							{
								if( k.length > 1500 )
								{
									cache.delete( k[ 0 ] );
								}
							} );
						}
					}
					return r;
				} )
				.catch( () => hit );
			return hit !== undefined ? hit : net;
		} )()
	);
} );
