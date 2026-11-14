---
id: bases-help
title: Places Bases View Help
---

## Settings

### Map

| Setting                      | Description                                                                                                                  | Examples                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Map provider                 | Service for rendering the map. Any installed map provider plugin is available                                                | {{dynamic:mapProviderNames}}                                                                                   |
| Style                        | Visual theme of the base map (varies by provider)                                                                            | streets, satellite, outdoors, light, dark, terrain                                                             |
| Height                       | Map height for embedded Bases views. The main Bases panel always fills available space                                       | **calc(100vh - 200px)**, 500px, 100vh                                                                          |
| Initial zoom                 | Zoom applied on load in place of framing the matched notes                                                                   | 12, 14.5                                                                                                       |
| Initial center               | Center applied on load in place of framing the matched notes                                                                 | 41.408, -75.662                                                                                                |
| Minimum zoom                 | Zoom level the map cannot go below                                                                                           | 3                                                                                                              |
| Show labels                  | Display text labels on markers                                                                                               | Toggle (default: on)                                                                                           |
| Show current device position | Add a current-position control on mobile devices; defaults to the global Places setting                                      | Toggle                                                                                                         |
| Marker renderer              | Render MapLibre markers as native symbols or HTML elements                                                                   | **native**, html                                                                                               |
| Cluster threshold            | Viewport point count at which cluster circles replace individual markers. Defaults to the global desktop or mobile threshold | Number                                                                                                         |
| Cluster GeoJSON overlays     | Include eligible GeoJSON overlay points in clustering                                                                        | Toggle                                                                                                         |
| POI discovery                | Click map features (trails, restaurants) to create notes. Requires vector tile providers                                     | Toggle (default follows global setting; per-view override allowed)                                             |
| Enable pitch/tilt            | Allow 3D perspective view. Right-click drag to tilt and rotate                                                               | Toggle (default: off)                                                                                          |
| Debug overlay                | Panel reporting camera position, feature counts, render timings, and the features under the cursor                           | Toggle (default: off)                                                                                          |
| Heatmap layer                | Render the matched notes as a density heatmap instead of individual markers                                                  | Toggle (default: off)                                                                                          |
| Heatmap color scheme         | Gradient for the heatmap layer: a preset name or a custom comma-separated hex list                                           | **plasma**, pastel, viridis, inferno, magma, heat, traffic, yellow-to-red, blues, or `#ffffcc,#fd8d3c,#e31a1c` |


### Terrain

| Setting              | Description                                                                                                                 | Examples                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Terrain provider     | DEM source. Setting it enables 3D terrain, hillshade at 0.5, and color relief at 0.4. Stored as `terrain.provider`          | {{dynamic:terrainProviderNames}}, aws, or a tile URL |
| Exaggeration         | Vertical exaggeration of the 3D surface. A constant factor, or a zoom curve of `@z` stops. Stored as `terrain.exaggeration` | **1.4**, 2, `1 @z6, 2.5 @z13`                        |
| Color relief opacity | Elevation-tint opacity, 0-1. 0 turns the tint off. Stored as `terrain.colorRelief.opacity`                                  | **0.4**, 0, 0.7                                      |

Hillshade tuning and the elevation color ramp are configured per code block. For complete terrain documentation: `places-terrain-help`

### Tracks

| Setting                  | Description                                                                             | Examples                                |
| ------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Color tracks by          | Metric coloring each route segment. Stored as `track.colorBy`                           | **none**, elevation, grade, speed, pace |
| Direction arrows         | Direction arrow scale on MapLibre tracks. Stored as `track.directionArrows`             | **1**, 0 (off), 0.5, 2                  |
| Default track visibility | `hidden` requires a marker click to display its track                                   | **hidden**, visible                     |
| Grade window             | Span the rolling grade is measured over. Stored as `track.gradeWindow`                  | **100ft**, 50m, 0.1mi                   |
| Track outline            | Contrasting border around track lines                                                   | Toggle (default: off)                   |
| Color legend             | Where to show the track color legend. Rendered only when coloring by elevation or grade | **hidden**, top, bottom                 |
| Track labels             | Which track labels to show; stored under `track.labels.visibility`                      | **all**, none, start, midpoint, end     |
| Track start label        | Template for the start label                                                            | `{this.title}`                          |
| Track midpoint label     | Template for the midpoint label                                                         | `{h.round(this.Distance)}`              |
| Track end label          | Template for the end label                                                              | Finish                                  |

### Overlays

| Setting  | Description                                                                                                                                                  | Examples                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Overlays | Expanded list of overlays. An entry can be a GeoJSON, GPX, or CSV file, a track note, a georeferenced image, or a vector tile source, as a vault path or URL | `- path: 02 - Overlays/scranton-neighborhoods.geojson` |

For complete overlay documentation: `places-overlay-help`

### Styling

| Setting        | Description                                                                             | Examples                         |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------------- |
| Custom CSS     | Raw CSS rules for markers/labels                                                        | .places-marker { opacity: 0.8; } |
| Icon styles    | Conditional icon styling rules, appended to the global icon styles                      | tag:hiking => opacity: 0.5       |
| Label styles   | Conditional label styling rules, appended to the global label styles                    | tag:favorite => color: gold      |
| Label template | Template for marker labels. Falls back to the global label template                     | {this.title} ({this.Rating})     |
| Icon rotation  | Template rotating each marker by its own data. Resolves to degrees clockwise from north | {this.bearing}                   |

For complete styling documentation: `places-style-help`

### Property Mappings

Property mappings specify which Base property each Places field reads from. Each is a property picker that accepts a frontmatter property, a file property, or a **formula** column for a computed value.

| Setting           | Description                                                  | Examples     |
| ----------------- | ------------------------------------------------------------ | ------------ |
| Location property | Property containing coordinates, such as "41.408, -75.662"   | **Location** |
| Title property    | Property used for marker display name (empty = use filename) | Title        |
| Icon property     | Property containing the marker emoji/icon                    | **icon**     |

Formula columns are supported because Places reads values through the Base property system. The value a formula produces is read as text and must parse as a coordinate pair.

One common case: notes store latitude and longitude separately. Add a formula property named `coords` that joins them into `latitude, longitude` text, then select it for Location. Left at its default, a mapping reads the matching frontmatter key directly (`Location`, `icon`, and the rest).

Track overlays are different. They always come from the `Overlay Source` and `Overlay Cache` frontmatter properties; those names are fixed.

For per-note display options, use individual frontmatter properties with the same setting names as query columns, such as `track.defaultVisibility`, `iconStyles`, and `labelStyles`. See `places-style-help` for the complete inventory and precedence.

## Places block features not available in Bases views

Query parameters, map tools including the track builder, directions, isochrones, and radius filtering are configured per code block and have no Bases view equivalent. 
