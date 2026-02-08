// ==UserScript==
// @name         Geo-FS HD Terrain & Multi-Source Imagery
// @namespace    http://tampermonkey.net/
// @version      0.1
// @author       Determina54
// @description  Fixes HD terrain, supports multi-map source switching (ESRI/Bing/Google/OSM), resolves night display issues.
// @match        https://www.geo-fs.com/geofs.php?v=*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ========== USER CONFIGURATION AREA: Switch map source here ==========
    const MAP_SOURCE = "esri"; // Options: "esri", "bing", "google", "osm", "apple"
    const MAX_ZOOM_LEVEL = 19; // Maximum zoom level (15-21, higher is clearer but may load slower)
    const FORCE_DAYTIME = false; // Set to true to attempt to lock daytime and avoid night issues

    // ========== Map Source Definitions ==========
    const mapSources = {
        // ESRI World Imagery - Default, most stable
        "esri": {
            name: "ESRI World Imagery",
            provider: () => new Cesium.ArcGisMapServerImageryProvider({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
                maximumLevel: MAX_ZOOM_LEVEL,
                enablePickFeatures: false
            })
        },
        // Bing Maps - Microsoft, high quality
        "bing": {
            name: "Bing Maps Aerial",
            provider: () => new Cesium.BingMapsImageryProvider({
                url: 'https://dev.virtualearth.net',
                key: 'AjrgR5TNicgFReuFwvNH71v4YeQNkXIB20l63ZMm86mVuBGZPhTHMkdiVq2_9L7x', // Bing Key public for Geo-FS
                mapStyle: Cesium.BingMapsStyle.AERIAL,
                maximumLevel: MAX_ZOOM_LEVEL
            })
        },
        // Google Satellite - May be blocked, but good quality
        "google": {
            name: "Google Satellite",
            provider: () => new Cesium.UrlTemplateImageryProvider({
                url: 'https://mt{0-3}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
                subdomains: ['0', '1', '2', '3'],
                maximumLevel: MAX_ZOOM_LEVEL,
                credit: 'Google'
            })
        },
        // OpenStreetMap - Street map, not satellite
        "osm": {
            name: "OpenStreetMap",
            provider: () => new Cesium.OpenStreetMapImageryProvider({
                url: 'https://a.tile.openstreetmap.org/',
                maximumLevel: MAX_ZOOM_LEVEL
            })
        },
        // Apple Maps - Alternative satellite source
        "apple": {
            name: "Apple MapKit",
            provider: () => new Cesium.UrlTemplateImageryProvider({
                url: 'https://sat-cdn{1-4}.apple-mapkit.com/tile?style=7&size=1&scale=1&z={z}&x={x}&y={y}&v=9651',
                subdomains: ['1', '2', '3', '4'],
                maximumLevel: MAX_ZOOM_LEVEL
            })
        }
    };

    // ========== Main Program ==========
    const waitForGeofs = setInterval(function() {
        if (window.geofs && window.Cesium) {
            clearInterval(waitForGeofs);
            console.log(`[Geo-FS HD] Core loaded, selected map source: ${MAP_SOURCE}`);

            // Enhanced viewer search
            let viewer = null;
            const possiblePaths = [
                () => window.geofs?.api?.viewer,
                () => window.geofsViewer,
                () => window.viewer,
                () => window.geofs?.viewer,
                () => window.geofs?.api?.scene?.viewer,
                () => window.Cesium?.viewer,
            ];

            for (let pathFunc of possiblePaths) {
                try {
                    viewer = pathFunc();
                    if (viewer) {
                        console.log(`[Geo-FS HD] Found viewer object`);
                        break;
                    }
                } catch(e) {}
            }

            if (!viewer) {
                console.error('[Geo-FS HD] Viewer not found, attempting deep search...');
                for (let key in window) {
                    try {
                        const obj = window[key];
                        if (obj && obj.scene && obj.imageryLayers) {
                            viewer = obj;
                            console.log(`[Geo-FS HD] Found via deep search: ${key}`);
                            break;
                        }
                    } catch(e) {}
                }
            }

            if (!viewer) {
                console.error('[Geo-FS HD] Fatal error: Unable to locate Cesium Viewer');
                return;
            }

            // Override core function
            window.geofs.geoIpUpdate = async function() {
                console.log(`[Geo-FS HD] Applying ${mapSources[MAP_SOURCE].name} map source...`);

                // 1. Apply selected map source
                try {
                    const selectedSource = mapSources[MAP_SOURCE];
                    if (!selectedSource) {
                        console.error(`[Geo-FS HD] Error: Unknown map source "${MAP_SOURCE}", using ESRI default`);
                        MAP_SOURCE = "esri";
                    }

                    const provider = selectedSource.provider();
                    viewer.imageryLayers.removeAll();
                    viewer.imageryLayers.addImageryProvider(provider);
                    console.log(`[Geo-FS HD] ${selectedSource.name} applied (Level:${MAX_ZOOM_LEVEL})`);

                    // Force layers to stay bright (solve night issues)
                    setTimeout(() => {
                        const layers = viewer.imageryLayers;
                        if (layers.length > 0) {
                            const layer = layers.get(0);
                            layer.alpha = 1.0;
                            layer.brightness = 1.1;
                            layer.show = true;
                            console.log('[Geo-FS HD] Imagery layer set to always bright mode');
                        }
                    }, 1500);

                } catch (mapError) {
                    console.error('[Geo-FS HD] Map setup failed:', mapError);
                    // If primary fails, attempt fallback to ESRI
                    if (MAP_SOURCE !== "esri") {
                        console.log('[Geo-FS HD] Attempting fallback to ESRI source...');
                        const fallback = mapSources["esri"].provider();
                        viewer.imageryLayers.removeAll();
                        viewer.imageryLayers.addImageryProvider(fallback);
                    }
                }

                // 2. Set up HD terrain
                try {
                    viewer.terrainProvider = new Cesium.CesiumTerrainProvider({
                        url: 'https://data.geo-fs.com/srtm/',
                        requestWaterMask: false,
                        requestVertexNormals: true
                    });
                    console.log('[Geo-FS HD] HD terrain set up');

                    // Optimize terrain fitting
                    setTimeout(() => {
                        if (viewer.scene && viewer.scene.globe) {
                            viewer.scene.globe._surface.tileProvider._heightmapTiles = {};
                            console.log('[Geo-FS HD] Terrain cache refreshed');
                        }
                    }, 3000);
                } catch (terrainError) {
                    console.warn('[Geo-FS HD] Terrain setup warning:', terrainError);
                }

                // 3. Mark status
                window.geofs.api = window.geofs.api || {};
                window.geofs.api.hdOn = true;
                console.log('[Geo-FS HD] Setup complete');
            };

            console.log('[Geo-FS HD] Function hooks completed');

            // Auto-trigger
            setTimeout(() => {
                if (window.geofs.geoIpUpdate) {
                    console.log('[Geo-FS HD] Auto-triggering initialization...');
                    window.geofs.geoIpUpdate();
                }
            }, 8000);

            // Optional: Lock daytime (if night issues are severe)
            if (FORCE_DAYTIME) {
                setInterval(() => {
                    try {
                        if (viewer.scene && viewer.scene.sun) {
                            viewer.scene.sun.brightness = 1.5;
                        }
                        // Attempt to find time control variable
                        if (window.geofs?.configuration?.current) {
                            window.geofs.configuration.current.time = 12.0;
                        }
                    } catch(e) {}
                }, 60000);
                console.log('[Geo-FS HD] Daytime lock mode enabled');
            }
        }
    }, 500);
})();
