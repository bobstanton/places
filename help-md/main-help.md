---
id: main-help
title: Places Help
---

# Places help

![[snippets/add-places-methods.md]]

{{dynamic:mapProviders}}

## ⚙️ Settings

All root-level settings for `places` code blocks. Settings with their own help page link to it in the description.

| Setting                   | Description                                                                                                                                           | Examples                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| mapProvider               | Which map service renders the background tiles. Defaults to the first available provider                                                              | {{dynamic:mapProviderNames}}                                               |
| style                     | Map theme or custom raster tile URL (Leaflet only). Named styles vary by provider                                                                     | streets, satellite, dark, `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |
| height                    | Container height. calc() sizes relative to the viewport                                                                                               | 400px, 50vh, 600px, calc(100vh - 200px)                                    |
| width                     | Container width. Usually 100% to fill the available space                                                                                             | **100%**, 800px, 90vw, calc(100% - 50px)                                   |
| initialZoom               | Initial map zoom level                                                                                                                                | **auto**, 10, 14, 18                                                       |
| initialCenter             | Initial map center as lat, lng                                                                                                                        | 41.408, -75.662                                                            |
| minZoom                   | Minimum map zoom level                                                                                                                                | 0, 3, 5                                                                    |
| query                     | VaultQuery SQL query to find notes with locations. See `places-query-help`                                                                            | SELECT * FROM places                                                       |
| dataview                  | Dataview DQL query to find notes with locations                                                                                                       | FROM "folder" WHERE location                                               |
| linkedPlaces              | Additional place notes to add by wiki link or note path                                                                                               | `[[Alfredos Pizza Cafe]], [[Poor Richards]]`                               |
| radius                    | Only show places within this distance. Center: inline `from lat, lng`, or the `location` setting, or the note's frontmatter Location (in that order)  | 50, 10mi, 50 from 41.408, -75.662                                          |
| location                  | Center coordinate for the radius filter when `from` is not in the radius value. Falls back to the note's frontmatter Location                         | 41.408333, -75.662500                                                      |
| fromTemplate              | Apply template note settings as defaults. One name or a list; later templates override earlier, and block keys override all                            | `[[Base Map]]`, or `[[Base]], [[Weather]]`                                 |
| showLabels                | Display text labels next to markers                                                                                                                   | **true**, false                                                            |
| labelTemplate             | Transform how labels display using placeholders and helper functions. See `places-style-help`                                                         | {h.before(this.name, '(')}, {this.filename}                                |
| markerFilter              | Show only markers matching a condition (icon and label together). Left side is a metadata field or the marker's `icon`/`name`; right side may be a `{parameter.*}` value. See `places-style-help` | `icon IN {parameter.activity}`, `rating >= 4`, `tag IN {parameter.show}` |
| markerRenderer            | Marker renderer for MapLibre-based providers. Native is the default; opt into HTML markers only when a block needs arbitrary marker CSS                | **native**, html                                                           |
| clusterThreshold          | Override marker clustering for this map. 0 disables clustering; positive numbers cluster when the point count reaches that threshold                  | 0, 100, 500                                                                |
| clusterGeoJsonOverlays    | Include point features from GeoJSON overlays in clustering for this map                                                                               | **true**, false                                                            |
| iconStyles                | Style icons conditionally with `condition => css-properties` rules. See `places-style-help` | Rating < 20 => opacity: 0.4                                                |
| labelStyles               | Style labels conditionally with `condition => css-properties` rules. See `places-style-help` | Type == "restaurant" => color: orange                                      |
| css                       | Inject raw CSS. Marker selectors need HTML markers (Leaflet, or `markerRenderer: html`); popup, legend, and container selectors match on every renderer. See `places-style-help` | `.places-marker-icon { opacity: 0.7; }`                                    |
| track                     | Track display, styling, labels, direction arrows, details, and shared selection parameters. See `places-overlay-help`                                | `colorBy: grade`<br>`defaultVisibility: visible`<br>`details: panel`       |
| legend                    | Show a color legend for elevation/grade track coloring                                                                                             | **hidden**, top, bottom                                                    |
| overlays                  | Map overlays: geodata files, note paths, georeferenced images, vector tile sources. Entry kind is inferred from its fields. See `places-overlay-help` | `- path: 02 - Overlays/scranton-neighborhoods.geojson`<br>`  minZoom: 9`<br>`  maxZoom: 12` |
| directions                | Generate routed paths between notes, coordinates, or query results. Each route takes `waypoints` or `query`. See `places-directions-help`             | `- mode: drive`<br>`  routes:`<br>`    - waypoints:`<br>`        - "[[Pizza By Alfredo]]"`<br>`        - "[[Alfredos Pizza Cafe]]"` |
| isochrones                | Generate reachable-area overlays around centers. See `places-isochrones-help`                                                                         | `- mode: walk`<br>`  ranges:`<br>`    - 10 min`<br>`    - 5 km`<br>`  centers:`<br>`    - "[[Dunder Mifflin Scranton]]"`<br>`    - "{this}"` |
| routeProvider             | Route service for `directions` and `isochrones` when it should differ from the map provider                                                           | {{dynamic:routeProviderNames}}                                             |
| queryParameters           | UI controls that adjust the block without editing it. See `places-queryparameters-help`                                                               | `- name: limit`<br>`  type: int`<br>`  min: 1`<br>`  max: 40`              |
| queryParametersPosition   | Where the parameter controls render                                                                                                                   | **below**, above, floating                                                 |
| queryParametersLayout     | Whether the parameter controls flow along a row or stack one per line                                                                                 | **horizontal**, vertical                                                   |
| queryParametersCollapsed  | Initial state of the strip's collapse toggle. Floating strips always have the toggle; declaring this adds it above or below too                        | true, **false**                                                            |
| tools                     | Extension-owned interactive MapLibre tools. Tool schemas and help come from the extension that registers each ID                                      | `playback:`<br>`  track: "[[Lake Scranton Weekend Run]]"`<br>`  camera: follow` |
| poiDiscovery              | Click map features (trails, restaurants, and other points of interest) to create notes. Requires vector tiles                                         | **true**, false                                                            |
| pitch                     | Enable 3D perspective. Right-click drag tilts and rotates the map                                                                                     | **false**, true                                                            |
| terrain                   | 3D terrain, hillshade, and color relief. `provider` selects the DEM source and enables it. See `places-terrain-help`. Not supported on Leaflet        | `provider: mapbox`<br>`exaggeration: 2`<br>`hillshade:`<br>`  intensity: 0.8` |
| showHelpWithEmptyMap      | When a block resolves to no places, the empty map still shows; this controls the help text below it. Overrides the global setting                     | **true**, false                                                            |
| debug                     | Diagnostics, combinable as a comma list. `true` overlays map state on the map; `settings` shows how each setting resolved; `parameters` traces parameter values, `{parameter.*}` substitutions, and markerFilter results, and adds a fields-and-filters inspector to marker popups | **false**, true, settings, parameters                                      |

## 📏 Filtering by radius

`radius` filters places after they've been collected from `query`, `dataview`, `linkedPlaces`, or the note's frontmatter Location.

~~~places
mapProvider: leaflet
query: SELECT * FROM places WHERE path LIKE '%Scranton%'
radius: "2 from Downtown Scranton: 41.408333, -75.662500"
~~~

Shows only places within 2 miles/km (based on unit settings) of the specified coordinate. 

Use `or` to include places near any of several points:

~~~places
mapProvider: leaflet
query: SELECT * FROM places WHERE path LIKE '%Scranton%'
radius: 15mi from 41.408, -75.662 or 41.573, -75.501 or 40.986, -75.195
~~~

Places within 15 miles of any of the three coordinates are shown.

The radius center can also come from the `location` setting or the note's frontmatter Location; the inline `from` value wins when both are present.

## 📄 Map templates

A template is a note. Put a `places-template` block in any note and point at it with a link:

~~~places-template
mapProvider: openfreemap
height: 500px
query: SELECT * FROM places_simple
~~~

Apply it from any map block:

~~~places
fromTemplate: [[Base Map]]
height: 600px
~~~

Which will result in an effective code block of 

~~~places
mapProvider: openfreemap
height: 600px
query: SELECT * FROM places_simple
~~~

Headings can be used to name and reference templates: `[[Styles#Category]]`. Multiple templates will apply in order, each overriding any values from the previous with the block's own keys having the final say.

## 🔌 Provider Plugins

Each provider is a separate plugin. The table below is built from the providers that are currently installed and configured:

{{dynamic:providerCapabilities}}

- **Maps**: markers, tracks, overlays.
- **Geocoding**: name search and reverse geocoding.
- **Elevation**: track and route profiles for `places-elevation` blocks.
- **Directions**: route lines between waypoints. Choose the service with `routeProvider`, or set `provider` inside one group.
- **Isochrones**: reachable-area GeoJSON around centers. Service selection matches directions.
- **Snap**: road-network cleanup for GPS tracks.
- **Track matching**: road and trail names matched to a recorded track.


## 🎯 Commands

All registered Places commands, extension-provided commands included:

{{dynamic:commands}}

## 📦 Available Code Blocks

Type any help page name below as a code block language to open it in any note. Rows without a code block are help pages for individual `places` settings:

{{dynamic:codeBlocks}}
