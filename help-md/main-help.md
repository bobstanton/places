---
id: main-help
title: Places Help
---

# Places help

![[snippets/add-places-methods.md]]

Indentation accepts spaces or tabs, including mixed indentation. Tabs advance to the next two-column stop; fields in one list entry must still line up. Tabs inside values and literal text are preserved.

{{dynamic:mapProviders}}

## ⚙️ Settings

All root-level settings for `places` code blocks. Settings with their own help page link to it in the description.

| Setting                        | Description                                                                                                                                                                                                                                                                        | Examples                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mapProvider                    | Which map service renders the background tiles. Defaults to the first available provider                                                                                                                                                                                           | {{dynamic:mapProviderNames}}                                                                                                                                       |
| style                          | Map theme or custom raster tile URL (Leaflet only). Named styles vary by provider                                                                                                                                                                                                  | streets, satellite, dark, `https://tile.openstreetmap.org/{z}/{x}/{y}.png`                                                                                         |
| height                         | Container height. calc() sizes relative to the viewport                                                                                                                                                                                                                            | 400px, 50vh, 600px, calc(100vh - 200px)                                                                                                                            |
| width                          | Width of everything the block renders, its legend and info included. A percentage measures the note's width, vw the window's                                                                                                                                                       | **100%**, 800px, 90vw, calc(100% - 50px)                                                                                                                           |
| initialZoom                    | Initial map zoom level                                                                                                                                                                                                                                                             | **auto**, 10, 14, 18                                                                                                                                               |
| initialCenter                  | Initial map center as lat, lng                                                                                                                                                                                                                                                     | 41.408, -75.662                                                                                                                                                    |
| minZoom                        | Minimum map zoom level                                                                                                                                                                                                                                                             | 0, 3, 5                                                                                                                                                            |
| query                          | VaultQuery SQL query to find notes with locations. See `places-query-help`                                                                                                                                                                                                         | SELECT * FROM places                                                                                                                                               |
| dataview                       | Dataview DQL query to find notes with locations                                                                                                                                                                                                                                    | FROM "folder" WHERE location                                                                                                                                       |
| places                         | A YAML list of linked notes/files and manual place mappings                                                                                                                                                                                                                        | `["[[Alfredos Pizza Cafe]]", "[[Poor Richards]]"]`                                                                                                                 |
| radius                         | Only show places within this distance. Center: inline `from lat, lng`, or the `location` setting, or the note's frontmatter Location (in that order)                                                                                                                               | 50, 10mi, 50 from 41.408, -75.662                                                                                                                                  |
| location                       | Center coordinate for the radius filter when `from` is not in the radius value. Falls back to the note's frontmatter Location                                                                                                                                                      | 41.408333, -75.662500                                                                                                                                              |
| fromTemplate                   | Apply template note settings as defaults. One name or a list; later templates override earlier, and block keys override all                                                                                                                                                        | `[[Base Map]]`, or `[[Base]], [[Weather]]`                                                                                                                         |
| defaultTemplate                | Set `false` to skip the vault-wide default template for this block; explicit `fromTemplate` and block settings still apply                                                                                                                                                         | false                                                                                                                                                              |
| showLabels                     | Display text labels next to markers                                                                                                                                                                                                                                                | **true**, false                                                                                                                                                    |
| showCurrentDevicePosition      | Add a current-position control on mobile devices, with a bearing arrow when compass access is available                                                                                                                                                                            | true, **false**                                                                                                                                                    |
| labelTemplate                  | Transform how labels display using placeholders and helper functions. See `places-style-help`                                                                                                                                                                                      | {h.before(this.name, '(')}, {this.filename}                                                                                                                        |
| iconImageStyles                | Conditional rules for picture markers, in `iconStyles` syntax. A picture is a square and unbordered without them; `background-color`, `border`, and `border-radius` frame it                                                                                                       | `- => border: 2px solid white`                                                                                                                                     |
| iconImage                      | Picture drawn as the marker, in place of the icon glyph. A vault path, an absolute path outside the vault, a URL, or a per-place template. Cropped to fill a square marker; framed by an `iconImageStyles` `border` / `border-radius`. Also accepts note and query overrides       | `{this.path}`                                                                                                                                                      |
| iconImageDetail                | Image pixel ratio for picture markers: `standard` is 1x, `sharp` is 2x, and `maximum` is 3x                                                                                                                                                                                        | **standard**, sharp, maximum                                                                                                                                       |
| iconRotation                   | Clockwise rotation in degrees or a per-place template. Also accepts note and query overrides. See `places-style-help`                                                                                                                                                              | 45, {this.bearing}                                                                                                                                                 |
| markerFilter                   | Show only markers matching a condition (icon and label together). Left side is a metadata field or the marker's `icon`/`name`; right side may be a `{parameter.*}` value; a list keeps a place matching any rule. See `places-queryparameters-help`                                | `icon IN {parameter.activity}`, `rating >= 4`, `tag IN {parameter.show}`                                                                                           |
| markerRenderer                 | Marker renderer for MapLibre-based providers. Native is the default; opt into HTML markers only when a block needs arbitrary marker CSS                                                                                                                                            | **native**, html                                                                                                                                                   |
| popup                          | Marker popup body sections. See `places-overlay-help`                                                                                                                                                                                                                              | `content:`<br>`  - renderer: knap`<br>`    options:`<br>`      templateFile: Templates/Popup.knap.md`<br>`  - note`<br>`  - renderer: environment.weather-summary` |
| markerMinZoom, markerMaxZoom   | Minimum and maximum zoom for marker icons. Each bound can also be a note property or query column. See `places-style-help`                                                                                                                                                         | 0–24                                                                                                                                                               |
| labelMinZoom, labelMaxZoom     | Minimum and maximum zoom for marker labels. Each bound can also be a note property or query column. See `places-style-help`                                                                                                                                                        | 0–24                                                                                                                                                               |
| trackMinZoom, trackMaxZoom     | Minimum and maximum zoom for tracks. Each bound can also be a note property or query column. See `places-style-help`                                                                                                                                                               | 0–24                                                                                                                                                               |
| overlayMinZoom, overlayMaxZoom | Minimum and maximum zoom for embedded overlays. Each bound can also be a note property or query column. See `places-style-help`                                                                                                                                                    | 0–24                                                                                                                                                               |
| clusterThreshold               | Override marker clustering for this map. 0 disables clustering; positive numbers cluster when the point count reaches that threshold                                                                                                                                               | 0, 100, 500                                                                                                                                                        |
| clusterGeoJsonOverlays         | Include point features from GeoJSON overlays in clustering for this map                                                                                                                                                                                                            | **true**, false                                                                                                                                                    |
| clusterStyle                   | Draw clusters as counted `circles` or as a density `heatmap`. Zoom drills into either; a click on the heatmap opens the places nearest it                                                                                                                                          | **circles**, heatmap                                                                                                                                               |
| heatmapColorScheme             | Gradient for `clusterStyle: heatmap`. Accepts preset names or comma-separated hex colors                                                                                                                                                                                           | **plasma**, pastel, viridis, inferno, magma, heat, traffic, yellow-to-red, blues                                                                                   |
| iconStyles                     | Style icons conditionally with `condition => css-properties` rules. See `places-style-help`                                                                                                                                                                                        | Rating < 20 => opacity: 0.4                                                                                                                                        |
| labelStyles                    | Style labels conditionally with `condition => css-properties` rules. See `places-style-help`                                                                                                                                                                                       | Type == "restaurant" => color: orange                                                                                                                              |
| css                            | Inject raw CSS. Marker selectors need HTML markers (Leaflet, or `markerRenderer: html`); popup, legend, and container selectors match on every renderer. See `places-style-help`                                                                                                   | `.places-marker-icon { opacity: 0.7; }`                                                                                                                            |
| track                          | Track display, styling, labels, direction arrows, details, and shared selection parameters. See `places-overlay-help`                                                                                                                                                              | `colorBy: grade`<br>`defaultVisibility: visible`<br>`details: panel`                                                                                               |
| legend                         | Show a color legend for elevation/grade track coloring                                                                                                                                                                                                                             | **hidden**, top, bottom                                                                                                                                            |
| overlays                       | Map overlays: geodata files, note paths, georeferenced images, vector tile sources. Entry kind is inferred from its fields. See `places-overlay-help`                                                                                                                              | `- path: 02 - Overlays/scranton-neighborhoods.geojson`<br>`  minZoom: 9`<br>`  maxZoom: 12`                                                                        |
| directions                     | Generate routed paths between notes, coordinates, or query results. Each route takes `waypoints` or `query`. See `places-directions-help`                                                                                                                                          | `- mode: drive`<br>`  routes:`<br>`    - waypoints:`<br>`        - "[[Pizza By Alfredo]]"`<br>`        - "[[Alfredos Pizza Cafe]]"`                                |
| isochrones                     | Generate reachable-area overlays around centers. See `places-isochrones-help`                                                                                                                                                                                                      | `- mode: walk`<br>`  ranges:`<br>`    - 10 min`<br>`    - 5 km`<br>`  centers:`<br>`    - "[[Dunder Mifflin Scranton]]"`<br>`    - "{this}"`                       |
| routeProvider                  | Route service for `directions` and `isochrones` when it should differ from the map provider                                                                                                                                                                                        | {{dynamic:routeProviderNames}}                                                                                                                                     |
| metricLabels                   | Which generated directions metrics to label. See `places-directions-help`                                                                                                                                                                                                          | **total**, legs, both, none                                                                                                                                        |
| routeLabelTemplate             | Template for generated route labels. See `places-directions-help`                                                                                                                                                                                                                  | {this.distance_text} · {this.duration_text}                                                                                                                        |
| legLabelTemplate               | Template for labels between direction stops. See `places-directions-help`                                                                                                                                                                                                          | {this.from_name} → {this.to_name}                                                                                                                                  |
| waypointLabelTemplate          | Template for route waypoint and GPX waypoint labels; empty text hides them. See `places-overlay-help`                                                                                                                                                                              | {this.name}                                                                                                                                                        |
| queryParameters                | UI controls that adjust the block without editing it; `queryParametersPosition`, `queryParametersLayout`, and `queryParametersCollapsed` place them. See `places-queryparameters-help`                                                                                             | `- name: limit`<br>`  type: int`<br>`  min: 1`<br>`  max: 40`                                                                                                      |
| queryParametersPosition        | Where the parameter controls render                                                                                                                                                                                                                                                | **below**, above, floating                                                                                                                                         |
| queryParametersLayout          | Whether the parameter controls flow along a row or stack one per line                                                                                                                                                                                                              | **horizontal**, vertical                                                                                                                                           |
| queryParametersCollapsed       | Initial state of the strip's collapse toggle. Floating strips always have the toggle; declaring this adds it above or below too                                                                                                                                                    | true, **false**                                                                                                                                                    |
| selection                      | Bind selected items, points, or this map's viewport to query parameters. See `places-queryparameters-help`                                                                                                                                                                         | `itemParameter: selected`<br>`viewportParameter: view`                                                                                                             |
| tools                          | Extension-owned interactive MapLibre tools. Tool schemas and help come from the extension that registers each ID                                                                                                                                                                   | `playback:`<br>`  track: "[[Lake Scranton Weekend Run]]"`<br>`  camera: follow`                                                                                    |
| poiDiscovery                   | Click map features (trails, restaurants, and other points of interest) to create notes. Requires vector tiles                                                                                                                                                                      | **true**, false                                                                                                                                                    |
| pitch                          | Enable 3D perspective. Right-click drag tilts and rotates the map                                                                                                                                                                                                                  | **false**, true                                                                                                                                                    |
| terrain                        | 3D terrain, hillshade, and color relief. `provider` selects the DEM source and enables it. See `places-terrain-help`. Not supported on Leaflet                                                                                                                                     | `provider: mapbox`<br>`exaggeration: 2`<br>`hillshade:`<br>`  intensity: 0.8`                                                                                      |
| showHelpWithEmptyMap           | When a block resolves to no places, the empty map still shows; this controls the help text below it. Overrides the global setting                                                                                                                                                  | **true**, false                                                                                                                                                    |
| debug                          | Diagnostics, combinable as a comma list. `true` overlays map state on the map; `settings` shows how each setting resolved; `parameters` traces parameter values, `{parameter.*}` substitutions, and markerFilter results, and adds a fields-and-filters inspector to marker popups | **false**, true, settings, parameters                                                                                                                              |

Unknown or misplaced optional settings are ignored. `debug: settings` lists ignored block setting paths and values alongside the settings resolution table. Missing required inputs, conflicting settings, and invalid values still report errors.

## 📏 Filtering by radius

`radius` filters places after they've been collected from `query`, `dataview`, `places`, or the note's frontmatter Location.

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

## Overlapping markers

Overlapping markers open a paged selector. Selecting a marker shows its track; paging away, opening the item list, or closing the popup hides it.

## Map loading

GL maps retry temporary tile failures in the background without moving the map. Restored connectivity prompts another attempt.

Cached tiles and local tracks remain available during network failures. Expired cached tiles can be used while the tile host is unavailable. Missing uncached tiles require a connection.

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

## New place content templates

In Places settings, set **New place content template** to a vault template file such as `Places Templates/New Place Knap.knap.md`. Its contents are a [Knap](https://knap.md/) template, applied when creating a place from search, a map point of interest, or the map context menu. Leave the setting empty to use the usual empty note body. The existing **Place note name format** continues to control filenames.

Templates may use `.knap.md`, `.md`, or `.knap`. Places reads the file when creating the note. For example, save this as the template:

````markdown
---
status: planned
---
# {{ title | escape_md }}

{% if address %}
{{ address | escape_md }}
{% endif %}

## Visit notes

```places
height: 300px
```
````

### Template data

New-place templates receive the creation data and the resolved note name and path. Optional request fields are absent when the creation source does not supply them.

| Variable                                                       | Value supplied                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                                         | Creation source: `place` for a search result, `poi` for a map point of interest, or `location` for map coordinates.                    |
| `name`                                                         | Search or point-of-interest name; the final note name for a coordinate-only request.                                                   |
| `title`                                                        | Final filename without `.md`, including any duplicate suffix.                                                                          |
| `path`                                                         | Destination vault path, including `.md`.                                                                                               |
| `latitude`, `longitude`                                        | Creation coordinates as numbers in degrees, for every creation source.                                                                 |
| `date`                                                         | Creation time as an ISO timestamp in UTC.                                                                                              |
| `tags`                                                         | Generated note tags after filtering; an empty array when absent.                                                                       |
| `properties`                                                   | Generated frontmatter before template properties are merged, including `properties.Location` and any generated address, tags, or icon. |
| `place`                                                        | Original creation request with `latitude` and `longitude` added. Search tags under `place.tags` retain their unfiltered values.        |
| `sourcePath`                                                   | Originating note path, when supplied.                                                                                                  |
| `lat`, `lng`                                                   | Original numeric coordinates for search and point-of-interest requests.                                                                |
| `coordinate`                                                   | Original `{ latitude, longitude }` object for coordinate-only requests.                                                                |
| `address`, `website`, `city`, `state`, `postalCode`, `country` | Search-result fields, when supplied by the search provider.                                                                            |
| `class`, `subclass`, `geometry`                                | Point-of-interest category, optional subcategory, and optional geometry.                                                               |

Optional YAML frontmatter adds properties. Places' generated properties take precedence on conflicts, including `Location`, address, tags, and icon when generated. Use `yaml` or `yaml_property` filters for dynamic YAML values. Invalid templates stop creation with an error before a file is written. Templates apply only to new place notes; updating existing notes and exporting tracks or routes do not apply them. Links in the generated body resolve from the new note's location.
