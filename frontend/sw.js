'use strict';
// Service worker: offline app shell plus cached map tiles. Stale-while-revalidate, so a new
// version of the app shows up on the second launch after an upload

// Bump SHELL's version to make activate discard old caches
const SHELL = 'trailweaver-shell-v20';
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
		'https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.45/dist/codicon.css',
	];

// allSettled: one failed download (for example the CDN while offline) must not abort the install
self.addEventListener( 'install', ( event ) =>
{
	event.waitUntil
		(
			caches
				.open( SHELL )
				.then( ( shellCache ) => Promise.allSettled( ASSETS.map( ( asset ) => shellCache.add( new Request( asset, { cache: 'reload' } ) ) ) ) )
				.then( () => self.skipWaiting() )
		);
} );

self.addEventListener( 'activate', ( event ) =>
{
	event.waitUntil
		(
			caches
				.keys()
				.then( ( cacheNames ) =>
					Promise.all(
						cacheNames
							.filter( ( cacheName ) => [ SHELL, TILES ].includes( cacheName ) === false )
							.map( ( cacheName ) => caches.delete( cacheName ) )
					)
				)
				.then( () => self.clients.claim() )
		);
} );

self.addEventListener( 'fetch', ( event ) =>
{
	// The sync upload is a POST and must always reach the network
	if( event.request.method !== 'GET' )
	{
		return;
	}

	const isTile = /tile\.(opentopomap|openstreetmap)\.org/.test( event.request.url );

	event.respondWith
		(
			( async () =>
			{
				const cache           = await caches.open( ( isTile === true ) ? TILES : SHELL );
				const cachedResponse  = await cache.match( event.request );
				const networkResponse = fetch( event.request )
					.then( ( response ) =>
					{
						// Opaque responses (cross-origin tiles and scripts) cannot be inspected but can be cached
						if( ( response !== undefined ) && ( ( response.ok === true ) || ( response.type === 'opaque' ) ) )
						{
							cache.put( event.request, response.clone() );

							// Tile cache limit: drop the oldest entry above 1500
							if( isTile === true )
							{
								cache.keys().then( ( cachedRequests ) =>
								{
									if( cachedRequests.length > 1500 )
									{
										cache.delete( cachedRequests[ 0 ] );
									}
								} );
							}
						}

						return response;
					} )
					.catch( () => cachedResponse );

				return ( cachedResponse !== undefined ) ? cachedResponse : networkResponse;
			} )()
		);
} );