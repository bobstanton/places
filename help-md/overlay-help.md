---
id: overlay-help
title: Places Overlays and Tracks Help
---

# Places Overlays and Tracks Help

Draw GeoJSON, GPX, CSV, track notes, georeferenced images, and vector tile sources over a map.

## Basic Usage

~~~places
mapProvider: leaflet
overlays:
  - path: 02 - Overlays/scranton-neighborhoods.geojson
height: 600px
dataview: FROM "Scranton" WHERE location
~~~

## Settings

| Setting       | Description                                                                                | Examples                          |
| ------------- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| path          | Geodata file, track note, or image file, as a note path or URL                             | 02 - Overlays/scranton-neighborhoods.geojson |
| labelTemplate | Label template resolved against overlay features                                           | {this.name}                       |
| waypointLabelTemplate | Label template for GPX `<wpt>` markers (defaults to the name; empty hides)          | Stop: {this.name}                 |
| minZoom       | Minimum map zoom where the overlay is visible                                              | 9                                 |
| maxZoom       | Maximum map zoom where the overlay is visible                                              | 12                                |
| bounds        | Marks the entry as an image overlay; axis-aligned georeference as swLat,swLng,neLat,neLng  | 41.408,-75.663,41.409,-75.662     |
| corners       | Marks the entry as an image overlay; four-corner georeference (rotated/skewed) as nwLat,nwLng,neLat,neLng,seLat,seLng,swLat,swLng | 41.409,-75.663,41.409,-75.662,41.408,-75.662,41.408,-75.663 |
| opacity       | Image entries: image opacity, 0-1                                                          | 0.8                               |
| visible       | Renders the entry when true (default); false skips it                                      | {parameter.showTrails}            |

Vector tile entries take `tiles` or a TileJSON `url`, plus `sourceLayer` (or `sourceLayers`), `layerType`, `filter`, `bounds`, and the style, label, and icon fields. 

### Multiple Overlays

~~~places
mapProvider: leaflet
overlays:
  - path: 02 - Overlays/scranton-neighborhoods.geojson
  - path: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson
~~~

### Zoom-Specific Overlays

Add `minZoom` and `maxZoom` options after the overlay path to swap datasets as the map zoom changes.

~~~places
mapProvider: leaflet
overlays:
  - path: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson
    maxZoom: 8
  - path: 02 - Overlays/scranton-neighborhoods.geojson
    minZoom: 9
~~~

### Interactive Overlay Visibility

`visible:` takes `{parameter.*}` placeholders: query parameter controls show and hide overlays. See the "Parameters in other settings" section of `places-queryparameters-help` for the toggle-per-overlay and multiselect examples.

### Overlay Label Templates

Add `labelTemplate` after a geodata overlay path to draw labels from feature properties.

The template belongs to that overlay only. `{this.propertyName}` reads simple names; anything with spaces or punctuation needs bracket access, as in `{this['district name']}`.

~~~places
mapProvider: openfreemap
overlays:
  - path: 02 - Overlays/scranton-neighborhoods.geojson
    labelTemplate: "{this.Name}"
    minZoom: 10
~~~

Labels are placed at the feature's point, line midpoint, or polygon center, and they respect the map's `showLabels` setting.

For GPX files and notes containing GPX data, embedded `<wpt>` waypoints are labeled with their name by
default. Use `waypointLabelTemplate` to customize that label; it applies only to `<wpt>` waypoints, not
the track line. The template resolves against each waypoint:

| Placeholder                                                                                | Description                     |
| ------------------------------------------------------------------------------------------ | ------------------------------- |
| `{this.name}`                                                                              | The waypoint's `<name>`         |
| `{this.description}`, `{this.symbol}`, `{this.type}`, `{this.comment}`, `{this.link}`      | The matching GPX elements       |
| `{this.elevation}`, `{this.time}`                                                          | The waypoint's elevation and timestamp |
| `{this.role}`                                                                              | Always `waypoint` here          |

An explicitly empty template hides the waypoint labels. This is the same
`waypointLabelTemplate` key used by directions route endpoints and the global setting of the same name.
One global template styles waypoints everywhere; the per-overlay value overrides it.

~~~places
overlays:
  - path: 91 - Random Routes for Heatmaps/Morning Run - Monday.md
    waypointLabelTemplate: "Stop: {this.name}"
~~~

If the same overlay also has `labelTemplate`, GPX waypoints use `waypointLabelTemplate` while the
general template applies to its other features.

### External GeoJSON URLs

~~~places
mapProvider: leaflet
overlays:
  - path: https://data.cityofnewyork.us/api/geospatial/arq3-7z49?method=export&format=GeoJSON
height: 500px
~~~

## GeoJSON Styling Properties

Styling is defined inside each GeoJSON feature's properties object. Places reads the simplestyle-spec properties below.

| Property           | Geometry      | Description                                      |
| ------------------ | ------------- | ------------------------------------------------ |
| `stroke`           | Line, Polygon | Line color (hex, rgb, or name): "#e63946", "red" |
| `stroke-width`     | Line, Polygon | Line thickness in pixels: 3, 5, 10               |
| `stroke-opacity`   | Line, Polygon | Line transparency (0-1): 0.8                     |
| `stroke-dasharray` | Line, Polygon | Dash pattern: "5,10", "10,5,2,5"                 |
| `fill`             | Polygon       | Fill color: "#2a9d8f", "rgba(0,100,200,0.5)"     |
| `fill-opacity`     | Polygon       | Fill transparency (0-1): 0.3                     |
| `marker-color`     | Point         | Marker color: "#ff0000"                          |
| `marker-size`      | Point         | Marker size: "small", "medium", "large"          |
| `marker-symbol`    | Point         | Icon symbol name (provider-specific)             |

### Example: Styled LineString

```json
{
  "type": "Feature",
  "geometry": {
    "type": "LineString",
    "coordinates": [[-73.99, 40.73], [-73.98, 40.74], [-73.97, 40.75]]
  },
  "properties": {
    "stroke": "#e63946",
    "stroke-width": 4,
    "stroke-opacity": 0.9,
    "stroke-dasharray": "10,5"
  }
}
```

### Example: Styled Polygon with Fill

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[
      [-73.99, 40.73], [-73.98, 40.73],
      [-73.98, 40.74], [-73.99, 40.74], [-73.99, 40.73]
    ]]
  },
  "properties": {
    "stroke": "#1d3557",
    "stroke-width": 2,
    "stroke-opacity": 1,
    "fill": "#a8dadc",
    "fill-opacity": 0.4
  }
}
```

### Example: Complete Styled File

Save as a .geojson file in the vault:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [...] },
      "properties": {
        "name": "Morning Run",
        "stroke": "#e63946",
        "stroke-width": 4,
        "stroke-opacity": 0.8
      }
    },
    {
      "type": "Feature",
      "geometry": { "type": "Polygon", "coordinates": [[...]] },
      "properties": {
        "name": "Park Boundary",
        "stroke": "#2a9d8f",
        "stroke-width": 2,
        "fill": "#2a9d8f",
        "fill-opacity": 0.2
      }
    }
  ]
}
```

- Exported heatmap analysis files include styling automatically

## Image Overlays

An `overlays:` entry with `bounds` or `corners` places a georeferenced image on the map.

### Axis-Aligned Rectangle (4 coordinates)

`bounds` uses `swLat,swLng,neLat,neLng`.

~~~places
mapProvider: leaflet
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    bounds: 41.25,-75.75,41.5,-75.5
    style:
      opacity: 0.8
~~~

### Rotated/Skewed Image (8 coordinates)

MapLibre/Mapbox only. `corners` uses `nwLat,nwLng,neLat,neLng,seLat,seLng,swLat,swLng`.

Corners specified clockwise from northwest.

~~~places
mapProvider: mapbox
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    corners: 41.5,-75.75,41.5,-75.5,41.25,-75.5,41.25,-75.75
    style:
      opacity: 0.7
~~~

Paths may be vault-relative, external URLs (http/https), or data URLs. Set an optional 0-1 opacity under a nested `style:` node.

## Vector Tile Overlays

Vector tile entries draw external Mapbox Vector Tile (MVT) sources on the map: contours, roads, land cover, or any vector tileset. Each entry needs a tile URL template or a TileJSON `url`, plus `sourceLayer` (or `sourceLayers`); `layerType` selects the rendering. Vector overlays render only on a MapLibre-based map provider, not Leaflet. Each entry supplies its own tile URL and key, independent of the base map.

### Basic usage

A vector overlay is visible only where the tileset has features at the current zoom. With no places to frame the map, `initialCenter` and `initialZoom` position it over that data:

~~~places
mapProvider: openfreemap
initialCenter: 41.408, -75.662
initialZoom: 13
overlays:
  - url: https://tiles.openfreemap.org/planet
    sourceLayer: transportation
    layerType: line
    style:
      color: "#d9480f"
      width: 2
    minZoom: 9
    maxZoom: 15
    bounds: -76.0,41.0,-75.4,41.6
~~~

`bounds` restricts the source to tiles overlapping the `west,south,east,north` box. The rendered edge follows tile boundaries rather than the exact coordinates.

Use `sourceLayers` when several source layers should share one style; it renders one MapLibre layer per source layer:

~~~places
mapProvider: openfreemap
overlays:
  - url: https://api.maptiler.com/tiles/v3/tiles.json?key=YOUR_KEY
    sourceLayers:
      - transportation
      - waterway
    layerType: line
    style:
      color: "#ff1744"
      width: 3
~~~

### Finding the layers in a tileset

A vector tileset's source layer names, and the properties available to filter on, are not guessable. When an entry has a TileJSON `url:`, Places reads the tileset's `vector_layers` and completes both: `sourceLayer:` offers the tileset's own layers (with their field count and zoom range), and `filter:` offers that layer's property names with the type each is declared as. Turn on `debug: true` to see the same list for every tileset in the block, alongside the properties of whatever feature is clicked.

Not every tileset declares `vector_layers`, an optional part of TileJSON, and a raw `tiles:` template has no metadata at all. Completion falls back to a format hint in that case.

A tile source is either a raw `tiles:` URL template (`https://host/{z}/{x}/{y}.pbf`) or a TileJSON `url:` endpoint. A TileJSON `url:` carries the tileset's zoom range and attribution: tiles beyond the tileset's maximum zoom overzoom instead of failing, and versioned tile paths resolve automatically. A raw `tiles:` template carries neither. `layerType` accepts `line` (default), `fill`, `circle`, and `symbol`. Put paint and sizing options under `style:`: `color`, `opacity`, `width`, `dashArray`, `fillColor`, `fillOpacity`, `circleRadius`, `strokeColor`, `strokeWidth`, `strokeOpacity`, and the text/icon sizing and color options. `dashArray` renders line layers dashed, from comma-separated dash and gap lengths (`dashArray: 2,2`). Use exactly one of `sourceLayer` or `sourceLayers`.

### Zoom-scaled styling

`width`, `opacity`, and `textSize` accept a zoom curve of `@z` stops (the same syntax as marker styling and terrain exaggeration), interpolating linearly between stops and clamping outside the range. Index contours that widen with zoom:

~~~places
mapProvider: openfreemap
initialCenter: 41.383, -75.633
initialZoom: 12
overlays:
  - url: https://tiles.openstreetmap.us/vector/contours-feet.json
    sourceLayer: contours
    layerType: line
    filter: idx == 1
    style:
      color: "#8a5a2a"
      width: 1 @z10, 2.5 @z14
~~~

### Filtering features

`filter` renders only matching features. One source layer can drive several styled overlays. A YAML array is a MapLibre filter expression, applied to the layer unchanged. A string is a shorthand: it compares a feature property to a literal (`==`, `!=`, `>`, `<`, `>=`, `<=`), joins clauses with `AND`, and treats a bare property name as a has-property test.

~~~places
mapProvider: mapbox
overlays:
  - tiles: https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/{z}/{x}/{y}.mvt?access_token=TOKEN
    sourceLayer: contour
    layerType: line
    filter: index == 1
    style:
      color: "#a06a3a"
      width: 1.4
  - tiles: https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/{z}/{x}/{y}.mvt?access_token=TOKEN
    sourceLayer: contour
    layerType: line
    filter: index != 1 AND ele >= 500
    style:
      color: "#c8a878"
      width: 0.6
~~~

A MapLibre filter expression supports operators the shorthand omits, including `in`, `any`, `!`, and `within` (which matches point and line features). An array value is passed to the layer unchanged, and MapLibre reports an invalid expression below the map.

~~~places
mapProvider: openfreemap
initialCenter: 41.408, -75.662
initialZoom: 13
overlays:
  - url: https://tiles.openfreemap.org/planet
    sourceLayer: transportation
    layerType: line
    filter: ["==", ["get", "class"], "motorway"]
    style:
      color: "#d9480f"
      width: 2
~~~

### Labels (symbol layers)

`layerType: symbol` labels features with `textField` (a feature property). Labels follow line geometry by default (`symbolPlacement: line`), which suits contours. Style with `textSize`, `textColor`, `textHaloColor`, and `textHaloWidth`.

~~~places
mapProvider: mapbox
overlays:
  - tiles: https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/{z}/{x}/{y}.mvt?access_token=TOKEN
    sourceLayer: contour
    layerType: symbol
    filter: index == 1
    textField: ele
    style:
      textSize: 11
      textColor: "#7a5a3a"
      textHaloColor: "#ffffff"
      textHaloWidth: 1
~~~

Symbol labels require the map style to provide fonts (glyphs); most vector styles do, but a raster-only base map may show no text.

### Icons (symbol layers)

`icon` renders a sprite image at each symbol feature. A bare name references an image in the base style's own sprite; `sprite` registers an external sprite sheet (its base URL, without the `.json` or `.png` suffix) and resolves `icon` against it. `style.iconSize` scales the icon. `icon` and `textField` combine on one entry; a symbol entry requires at least one of them. External sprites require a MapLibre GL engine; the mapbox provider renders such an entry without the icon.

~~~places
mapProvider: openfreemap
initialCenter: 41.383, -75.633
initialZoom: 13
overlays:
  - url: https://tiles.openstreetmap.us/vector/trails.json
    sourceLayer: trail_poi
    layerType: symbol
    symbolPlacement: point
    sprite: https://maputnik.github.io/osm-liberty/sprites/osm-liberty
    icon: information
~~~

### Providers with vector tiles

Accepts any MVT source. These providers publish vector tilesets. Source-layer names and filterable attributes differ per provider; consult each tileset schema.

| Provider    | Vector tiles                        | Contours                                             | Key     |
| ----------- | ----------------------------------- | ---------------------------------------------------- | ------- |
| Mapbox      | Terrain v2, Streets v8              | `contour` (attr `index`), `hillshade`                | token   |
| MapTiler    | Contours, Streets (OpenMapTiles)    | `contour` / `contour_ft` (attr `height`, `nth_line`) | key     |
| Stadia      | Landcover, Bathymetry, OpenMapTiles | none                                                 | api_key |
| OpenFreeMap | OpenMapTiles planet                 | none                                                 | none    |
| Geoapify    | OpenMapTiles vector                 | none                                                 | apiKey  |

#### MapTiler contours

~~~places
mapProvider: maptiler
initialCenter: 41.573, -75.501
initialZoom: 13
overlays:
  - tiles: https://api.maptiler.com/tiles/contours-v2/{z}/{x}/{y}.pbf?key=YOUR_KEY
    sourceLayer: contour
    layerType: line
    filter: nth_line >= 5
    style:
      color: "#a06a3a"
      width: 1
~~~

#### OpenFreeMap

OpenMapTiles schema; source layers include `transportation`, `building`, `water`, `landcover`, `landuse`, `place`. Reference the tiles with the TileJSON `url:` (`https://tiles.openfreemap.org/planet`), not a raw `{z}/{x}/{y}.pbf` template. Each source layer has its own zoom range: `building` carries features only from zoom 13 up. Position the map over a built-up area at that zoom or higher (here downtown Scranton at zoom 16). Below zoom 13 the layer is empty and the fill has nothing to draw:

~~~places
mapProvider: openfreemap
initialCenter: 41.408, -75.662
initialZoom: 16
overlays:
  - url: https://tiles.openfreemap.org/planet
    sourceLayer: building
    layerType: fill
    style:
      fillColor: "#c0392b"
      fillOpacity: 0.3
~~~

#### Stadia land cover

~~~places
mapProvider: stadia
initialCenter: 41.408, -75.662
initialZoom: 7
overlays:
  - tiles: https://tiles.stadiamaps.com/data/global_landcover_v1/{z}/{x}/{y}.pbf?api_key=YOUR_KEY
    sourceLayer: global_landcover
    layerType: fill
    style:
      fillColor: "#2e7d32"
      fillOpacity: 0.25
~~~

### Combining Overlay Types

One `overlays:` list can carry every kind at once. An entry with `bounds:` or `corners:` (or a raster extension) is an image; an entry with `tiles:` or a TileJSON `url:` plus `sourceLayer` is a vector tile source; everything else is geodata.

~~~places
mapProvider: mapbox
overlays:
  - path: 02 - Overlays/scranton-neighborhoods.geojson
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    bounds: 41.25,-75.75,41.5,-75.5
    style:
      opacity: 0.7
  - url: https://tiles.openfreemap.org/planet
    sourceLayer: transportation
    layerType: line
    style:
      color: "#d9480f"
      width: 2
~~~

### Interactive Alignment Tool

Use `places-image-align-help` to learn about the interactive image alignment tool. It requires a map provider with alignment support (installed: {{dynamic:imageAlignmentProviderNames}}).

## Generated Route and Isochrone Overlays

`directions` and `isochrones` generate GeoJSON route and reachable-area overlays from an installed route provider. See `places-directions-help` and `places-isochrones-help` for the full guides, including traffic-aware routing and provider selection.

## Track Coloring

Color tracks by elevation, grade, speed, or pace.

Elevation and grade need per-point elevations; speed and pace need per-point timestamps. A GPX with `<time>` on its track points carries both. A track imported before Places recorded timestamps has none stored in its cache. Run **Rebuild all overlay caches** from the command palette to re-derive every cached overlay from its source, or **Rebuild overlay cache** for a single note. The source is never modified. A track whose source genuinely has no timestamps (a GeoJSON exported without them, or a plain polyline) is reported as such, because no rebuild will give it speeds. Without the data the mode needs, the track draws as a plain line rather than silently switching to another coloring.

Speed and pace use a sequential blue-to-red ramp, normalized against that track's own range: a walk and a drive each use the full scale. Pace inverts it, keeping fast at the red end in both. The span they are averaged over is `speedWindow`. See the chart help for how the windows work.

MapLibre-based maps show direction arrows at detailed zoom levels and mark each rendered track segment's start and end. Clicking a trail opens source-backed details; when Places Utilities playback is enabled without a fixed `track`, the same click selects that trail for playback.

Set `track.details: panel` to show those details in a fixed map panel instead of a popup. The panel follows the playback position while playing, scrubbing, or dragging. The default is `popup`.

| Setting               | Description                                                                            | Examples                                |
| --------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| `colorBy`             | Color tracks by data: altitude, slope steepness, speed, pace, or single solid color | **none**, elevation, grade, speed, pace |
| `gradeWindow`         | Span the rolling grade is measured over. Larger = smoother lines, less GPS noise       | **100ft**, 50m, 0.1mi                   |
| `defaultVisibility`   | Whether routes are visible when map loads. `hidden` requires clicking markers          | **hidden**, visible                     |
| `directionArrows`     | Direction arrow scale on MapLibre tracks. 0 hides them                                 | **1**, 0.7, 0                           |
| `speedWindow`         | Span speed and pace are averaged over: a distance, or a time that reads better across stops | **200m**, 0.25mi, 30s               |
| `outline`             | Outline around track lines. Unset, colored tracks get one and single-color tracks do not | true, false                           |
| `details`             | Clicked-point details presentation                                                     | **popup**, panel                        |
| `labels`              | Track start, midpoint, and end labels; see Path Overlay Labels below                   | `visibility: all`                       |
| `selection`           | Parameters written by track and point selection; see `places-queryparameters-help`     | `trackParameter: selected`              |

### Colored Elevation Tracks

~~~places
mapProvider: leaflet
track:
  colorBy: grade
  gradeDistance: 100
height: 400px
~~~

### Show All Tracks by Default

~~~places
mapProvider: leaflet
track:
  defaultVisibility: visible
dataview: FROM "91 - Random Routes for Heatmaps"
  WHERE "Overlay Source"
~~~

All tracks from the query will be visible on initial map load. Click markers to toggle individual tracks on/off.

A drawn track is itself a click target: clicking opens its place popup and leaves the line visible. 

## Path Overlay Labels

GPX/path overlays (tracks from `Overlay Source`) can show text labels at the **start**, **midpoint**, and **end** of the line - similar to the distance/time label on generated directions. Each label only appears while its track is visible, and labels respect collision (they hide rather than overlap).

Labels are templates resolved against the **track note's frontmatter**, using the same engine as VaultQuery. Frontmatter keys are top-level. A key with a space needs bracket form:

- `{this.Distance}` -> the note's `Distance` frontmatter (used verbatim, e.g. `1.30 mi`)
- `{this['Elevation Gain']}` -> the note's `Elevation Gain` frontmatter
- built-ins like `{this.title}`, `{this.tags}`, and helpers like `{h.wikilink(this.path)}` are also supported
- `{h.round(this.Distance)}` rounds a number to at most 2 decimals, keeping any unit (e.g. `3.7476` -> `3.75`, `6.38 mi` -> `6.38 mi`)

Values are taken straight from frontmatter - nothing is parsed from the track or unit-converted.

## Importing Tracks

Drag and drop GPX/GeoJSON/CSV files to the folder tree or use the `Import track data` command.

