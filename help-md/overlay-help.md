---
id: overlay-help
title: Places Overlays and Tracks Help
---

# Places Overlays and Tracks Help

## Basic Usage

~~~places
mapProvider: leaflet
overlays:
  - path: 02 - Overlays/scranton-neighborhoods.geojson
height: 600px
dataview: FROM "Scranton" WHERE location
~~~

## Settings

| Setting               | Description                                                                                                                       | Examples                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| path                  | Geodata file (`.geojson`, `.gpx`, `.fit`, `.csv`), track note, or image file, as a note path or URL                               | 02 - Overlays/scranton-neighborhoods.geojson                                                                 |
| labelTemplate         | Label template resolved against overlay features                                                                                  | {this.name}                                                                                                  |
| waypointLabelTemplate | Label template for GPX `<wpt>` markers (defaults to the name; empty hides)                                                        | Stop: {this.name}                                                                                            |
| popup                 | Popup body sections for a clicked feature; a vector tile overlay's features answer clicks only with one                           | `content:`<br>`  - renderer: knap`<br>`    options:`<br>`      templateFile: Places Templates/Popup.knap.md` |
| hoverStyle            | Style overrides applied to the feature under the pointer (MapLibre providers); same keys as `style`                               |                                                                                                              |
| minZoom               | Minimum map zoom where the overlay is visible                                                                                     | 9                                                                                                            |
| maxZoom               | Maximum map zoom where the overlay is visible                                                                                     | 12                                                                                                           |
| bounds                | Marks the entry as an image overlay; axis-aligned georeference as swLat,swLng,neLat,neLng                                         | 41.408,-75.663,41.409,-75.662                                                                                |
| corners               | Marks the entry as an image overlay; four-corner georeference (rotated/skewed) as nwLat,nwLng,neLat,neLng,seLat,seLng,swLat,swLng | 41.409,-75.663,41.409,-75.662,41.408,-75.662,41.408,-75.663                                                  |
| opacity               | Image entries: image opacity, 0-1                                                                                                 | 0.8                                                                                                          |
| visible               | Renders the entry when true (default); false skips it                                                                             | {parameter.showTrails}                                                                                       |
| preset                | A vector tileset an installed extension supplies, in place of `tiles` or `url`                                                    | mapillary                                                                                                    |

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

GeoJSON features with `geometry: null` have no location to draw or label. They remain in the loaded data and do not prevent the other features from rendering.

For GPX files and notes containing GPX data, embedded `<wpt>` waypoints are labeled with their name by
default. Use `waypointLabelTemplate` to customize that label; it applies only to `<wpt>` waypoints, not
the track line. The template resolves against each waypoint:

| Placeholder                                                                           | Description                            |
| ------------------------------------------------------------------------------------- | -------------------------------------- |
| `{this.name}`                                                                         | The waypoint's `<name>`                |
| `{this.description}`, `{this.symbol}`, `{this.type}`, `{this.comment}`, `{this.link}` | The matching GPX elements              |
| `{this.elevation}`, `{this.time}`                                                     | The waypoint's elevation and timestamp |
| `{this.role}`                                                                         | Always `waypoint` here                 |

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

### Waypoint Icons

Places settings includes **Waypoint icons**. Each line maps an exact waypoint name, symbol, or type to an emoji, ignoring capitalization and surrounding whitespace:

~~~text
Overlook => 👀
Trailhead => 🥾
Waterfall => 🌊
~~~

These mappings are included by default. Add `name:`, `sym:`, or `type:` before a value to match just that field, such as `sym: Overlook => 👀`. Symbol mappings take priority, followed by a literal symbol emoji, type mappings, and name mappings. Later mappings for the same field and value replace earlier ones.

### Popup Content

Use `popup.content` to choose and order the body sections:

~~~places
popup:
  content:
    - renderer: knap
      options:
        templateFile: Places Templates/Popup.knap.md
    - note
    - renderer: environment.weather-summary
~~~

`renderer: knap` renders an external Markdown template with the clicked place or feature data. `note` renders the note body without embedded maps. Interactive renderers include the built-in `image.preview` for photo rows from `image_files`, and those supplied by installed extensions. Omit `popup` to display the note body. Use `content: none` to show only the popup header.

Notes and query results can override this block content using individual properties or columns such as `popup.content.renderer`, `popup.content.options.templateFile`, or `popup.content: none`. Query columns take precedence over note properties, then the block. See `places-style-help` for their syntax and the full inventory.

### Knap popup templates

Use the built-in `knap` renderer for Markdown with conditions, loops, and [Knap filters](https://knap.md/filters):

~~~places
popup:
  content:
    - renderer: knap
      options:
        templateFile: Places Templates/Popup.knap.md
~~~

Save the template in `Places Templates/Popup.knap.md`:

~~~markdown
### {{ name | escape_md }}
{% if frontmatter.Address %}
{{ frontmatter.Address | escape_md }}
{% endif %}
{% if tags %}
{{ tags | wikilink | join:", " }}
{% endif %}
~~~

`templateFile` references a file in the vault (`.knap.md`, `.md`, or `.knap`). Markdown template notes also support quoted wikilinks. Places reads the file when opening the popup.

#### Place-marker data

Place-marker popups pass the following variables to the template. Query-backed markers also include their query row.

| Variable                  | Value supplied                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | Displayed marker name, after label-template processing.                                                                       |
| `originalName`            | Name before label-template processing; defaults to `name`.                                                                    |
| `title`, `filename`       | Linked filename without `.md`; defaults to `name` for a place without a file.                                                 |
| `path`                    | Linked vault file path, including its extension; empty when no file is linked.                                                |
| `icon`                    | Marker icon text.                                                                                                             |
| `latitude`, `longitude`   | Marker coordinates as numbers in degrees.                                                                                     |
| `tags`                    | Array of place tags; empty when no tags are present.                                                                          |
| `frontmatter`             | Place metadata with its original keys, such as `frontmatter.Address` and `frontmatter.Favorite`; an empty object when absent. |
| `row`                     | Original query row with its column names; an empty object for a place without a query row.                                    |
| Metadata and query fields | Also available at the top level under their original names and generated aliases, such as `Address` and `address`.            |

Built-in variables in the table take precedence over metadata and query fields with the same name. For other exact-name conflicts, metadata takes precedence over query columns. `frontmatter` and `row` retain the original values.

Aliases include lowercase keys and lowercase keys with spaces replaced by underscores: `Last Visited` adds `last visited` and `last_visited`. Lowercase keys and keys containing underscores or hyphens also receive a title-case alias: `rating_value` adds `Rating Value`. Aliases fill unused names, with query aliases added first.

#### Overlay-feature data

Overlay-feature popups pass a different set of variables. Property names retain their original spelling without the place-marker aliases. `properties`, `geometry`, `feature`, and `source` take precedence over properties with those names. A supplied feature index takes precedence over a property named `index`.

| Variable               | Value supplied                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Feature property names | Clicked feature properties at the top level, preserving their original names; for example, `Name` and `Population`. |
| `properties`           | Complete feature properties object, preserving keys that conflict with other template variables.                    |
| `geometry`             | Feature geometry, including `geometry.type` and `geometry.coordinates`; may be null.                                |
| `feature`              | Complete clicked GeoJSON feature, including `feature.id` when present.                                              |
| `source`               | Overlay source identifier supplied with the popup; empty when none is supplied.                                     |
| `index`                | Feature index supplied with the popup, when available; otherwise the feature property named `index`, if present.    |
| `role`                 | Feature property when present; otherwise `waypoint` for a GPX waypoint, or empty.                                   |
| `role_label`           | Feature property when present; otherwise empty. Generated route endpoints supply labels such as `Start` and `End`.  |

Missing values render as empty text. Invalid templates restore the normal popup content. Links and embeds resolve from the popup's Markdown source path. Knap renders the popup body; actions and interactive renderers remain separate sections. Regex searches in Knap filters are disabled.

Installed popup renderers:

{{dynamic:popupRenderers}}

Geodata and vector tile overlays accept the same setting on an individual entry. The template receives the clicked feature:

~~~places
overlays:
  - path: 02 - Overlays/scranton-neighborhoods.geojson
    popup:
      content:
        - renderer: knap
          options:
            templateFile: Templates/Neighborhood.knap.md
~~~

Save `Templates/Neighborhood.knap.md` with:

~~~markdown
### {{ Name | escape_md }}
**Population:** {{ Population }}
**Geometry:** {{ geometry.type }}
~~~

Omit a geodata overlay's `popup` to keep its existing feature details. A `note` section renders the source when the overlay is backed by a vault note. A vector tile overlay without a `popup` draws for context only: its features answer no clicks.

### External GeoJSON URLs

~~~places
mapProvider: leaflet
overlays:
  - path: https://data.cityofnewyork.us/api/geospatial/arq3-7z49?method=export&format=GeoJSON
height: 500px
~~~

## GeoJSON Styling Properties

Places reads the following styling properties from each GeoJSON feature:

| Property           | Geometry      | Description                                                             |
| ------------------ | ------------- | ----------------------------------------------------------------------- |
| `stroke`           | Line, Polygon | Line color (hex, rgb, or name): "#e63946", "red"                        |
| `stroke-width`     | Line, Polygon | Line thickness in pixels: 3, 5, 10                                      |
| `stroke-opacity`   | Line, Polygon | Line transparency (0-1): 0.8                                            |
| `stroke-dasharray` | Line          | Dash and gap lengths in pixels: `"5,10"` or `"5 10"`; empty means solid |
| `fill`             | Polygon       | Fill color: "#2a9d8f", "rgba(0,100,200,0.5)"                            |
| `fill-opacity`     | Polygon       | Fill transparency (0-1): 0.3                                            |
| `marker-color`     | Point         | Marker color: "#ff0000"                                                 |
| `marker-size`      | Point         | Marker size: "small", "medium", "large"                                 |
| `marker-symbol`    | Point         | Icon symbol name (provider-specific)                                    |

MapLibre uses the first line's dash pattern for an entire track or GeoJSON overlay. Use separate overlays for different dash patterns. In GeoJSON, dash lengths are in pixels; overlay `style.dashArray` uses multiples of line width.

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

Vector tile entries draw Mapbox Vector Tile (MVT) sources. Each entry needs a tile URL template, a TileJSON `url`, or a `path` to a `.pmtiles` archive in the vault (`tileJson: true` marks a `tiles` address as a TileJSON document when it does not end in `.json`), plus `sourceLayer` (or `sourceLayers`); `layerType` selects the rendering. Vector overlays render only on a MapLibre-based map provider, not Leaflet.

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

### Local archives

Set `path` to the `.pmtiles` archive's vault path. Source layers and zoom range are read from the archive.

~~~places
mapProvider: openfreemap
initialCenter: 41.408, -75.662
initialZoom: 13
overlays:
  - path: Maps/scranton.pmtiles
    sourceLayer: roads
    layerType: line
    style:
      color: "#d9480f"
      width: 2
~~~

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

A TileJSON `url:` carries the tileset's zoom range and attribution: tiles beyond the tileset's maximum zoom overzoom instead of failing, and versioned tile paths resolve automatically. A raw `tiles:` template carries neither. `layerType` accepts `line` (default), `fill`, `circle`, and `symbol`. Put paint and sizing options under `style:`: `color`, `opacity`, `width`, `dashArray`, `fillColor`, `fillOpacity`, `circleRadius`, `strokeColor`, `strokeWidth`, `strokeOpacity`, and the text/icon sizing and color options. `dashArray` takes comma-separated dash and gap lengths in multiples of line width. For example, `width: 3` with `dashArray: "2,5"` draws 6-pixel dashes and 15-pixel gaps. Use exactly one of `sourceLayer` or `sourceLayers`.

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

`icon` renders a sprite image at each symbol feature; `iconSize` under `style` scales it (1 is the sprite's own size). A bare name references an image in the base style's own sprite; `sprite` registers an external sprite sheet (its base URL, without the `.json` or `.png` suffix) and resolves `icon` against it. `style.iconSize` scales the icon. `icon` and `textField` combine on one entry; a symbol entry requires at least one of them. External sprites require a MapLibre GL engine; the mapbox provider renders such an entry without the icon.

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

### Overlay presets

An installed extension can supply a vector tileset by name. The entry needs no `tiles` or `url`, and any access token stays in that extension's settings rather than in the note:

~~~places
overlays:
  - preset: mapillary
~~~

`sourceLayers` draws only some of the preset's layers, and `minZoom`, `maxZoom`, `filter`, `style`, and `popup` replace the preset's own:

~~~places
overlays:
  - preset: mapillary
    sourceLayers: [sequence, image]
    filter: is_pano == true
    style:
      color: "#7c3aed"
~~~

Installed overlay presets:

{{dynamic:overlayPresets}}

A preset's features that open a popup appear in the map's click stack along with markers and tracks under the same point.

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

For tracks imported with an older version, **Rebuild overlay cache** refreshes the cached data from `Overlay Source`. **Rebuild all overlay caches** updates all cached overlays. A coloring mode with missing data displays a plain line.

Speed and pace use each track's range for the blue-to-red scale, with faster sections at the red end. `speedWindow` sets the averaging distance or time.

MapLibre-based maps show direction arrows at detailed zoom levels and mark each rendered track segment's start and end. Clicking a trail opens source-backed details; when Places Utilities playback is enabled without a fixed `track`, the same click selects that trail for playback.

Set `track.details: panel` to show those details in a fixed map panel instead of a popup. The panel follows the playback position while playing, scrubbing, or dragging. The default is `popup`.

| Setting             | Description                                                                                                          | Examples                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `colorBy`           | Color tracks by elevation, grade, speed, pace, or a single color (dashed by default)                                 | **none**, elevation, grade, speed, pace |
| `style`             | Width, solid/dashed, color, opacity; optional outline after a semicolon. Unspecified components inherit              | `"4 solid red; 8 solid black 0.3"`      |
| `gradeWindow`       | Span the rolling grade is measured over. Larger = smoother lines, less GPS noise                                     | **100ft**, 50m, 0.1mi                   |
| `defaultVisibility` | Initial track visibility. When omitted, a single unclustered track shows automatically; multiple tracks start hidden | visible, hidden                         |
| `directionArrows`   | Direction arrow scale on MapLibre tracks. 0 hides them                                                               | **1**, 0.7, 0                           |
| `speedWindow`       | Span speed and pace are averaged over: a distance, or a time that reads better across stops                          | **200m**, 0.25mi, 30s                   |
| `outline`           | Outline around track lines. Unset, colored tracks get one and single-color tracks do not                             | true, false                             |
| `details`           | Clicked-point details presentation                                                                                   | **popup**, panel                        |
| `labels`            | Track start, midpoint, and end labels; see Track Labels below                                                        | `visibility: all`                       |
| `selection`         | Parameters written by track and point selection; see `places-queryparameters-help`                                   | `trackParameter: selected`              |

These options are nested under `track:` in code blocks. The per-place subset also works as individual note properties and query columns: `track.colorBy`, `track.style`, `track.defaultVisibility`, `track.outline`, and `track.labels.visibility`/`start`/`midpoint`/`end`. Query rows override note settings, which override the code block. See `places-style-help` for the full inventory and syntax.

### Grade-Colored Tracks

~~~places
mapProvider: leaflet
track:
  colorBy: grade
  gradeWindow: 100ft
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

## Track Labels

Track overlays (from `Overlay Source` or `Overlay Cache`) can show text labels at the **start**, **midpoint**, and **end** of the line. Labels appear while their track is visible and hide when they would overlap.

Labels are templates resolved against the **track note's frontmatter**, using the same engine as VaultQuery. Frontmatter keys are top-level. A key with a space needs bracket form:

- `{this.Distance}` -> the note's `Distance` frontmatter (used verbatim, e.g. `1.30 mi`)
- `{this['Elevation Gain']}` -> the note's `Elevation Gain` frontmatter
- built-ins like `{this.title}`, `{this.tags}`, and helpers like `{h.wikilink(this.path)}` are also supported
- `{h.round(this.Distance)}` rounds a number to at most 2 decimals, keeping any unit (e.g. `3.7476` -> `3.75`, `6.38 mi` -> `6.38 mi`)

For a single continuous track, labels use the note's frontmatter values as stored. For a track with separate segments, each segment gets its own labels: `Distance` and available elevation figures are calculated from that segment, and `{this.Segment}` and `{this['Segment Count']}` identify it. Note-wide time and speed figures are blank in those segment labels.

Use `track.labels.visibility: all`, `none`, or a comma-separated selection of `start`, `midpoint`, and `end`. `mid` and `middle` also select `midpoint`. Set templates under `track.labels.start`, `midpoint`, and `end`. Use these dotted names as individual query columns or note properties; an empty template disables that label. Templates inherit separately for each slot.

## Importing Tracks

Drag and drop GPX/FIT/GeoJSON/CSV files to the folder tree or use the `Import track data` command.

To copy files into your vault without creating track notes, hold **Option on macOS** or **Ctrl on Windows/Linux** while dropping them onto a folder in the file explorer. Dropping an external file into a note with this shortcut creates a link to the original file.
