---
id: style-help
title: Places Styling Help
---

# Places Styling Help

Apply custom styles to marker icons and labels.

## Marker Renderers

Markers can be rendered using MapLibre GL symbols or HTML. MapLibre-based providers render markers as native GL symbols by default. Native markers cannot be styled with CSS. Structured `iconStyles`/`labelStyles` rules are translated to native layer properties or to CSS when using HTML rendering.

| Mechanism                                                                       | Native markers (default)            | HTML markers                                              |
| ------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| `iconStyles`/`labelStyles` structured properties                                | yes, translated to GL expressions   | yes                                                       |
| `iconStyles` badges, halos, zoom sizing (`content:`, `drop-shadow`, `@z` stops) | yes, composited into the icon image | yes, generated `::before` classes and `--map-zoom` curves |
| `iconStyles`/`labelStyles` arbitrary CSS, classes                               | no                                  | yes                                                       |
| `css:` targeting `.places-marker*`                                              | no                                  | yes                                                       |
| `css:` targeting popups, legends, containers, controls                          | yes                                 | yes                                                       |

## Style Rule Syntax

Rules follow the format: condition => declarations

Declarations are written in CSS syntax. Native markers apply the translated subset listed under `iconStyles` and `labelStyles` Properties; HTML markers accept any CSS.

Each declaration must end with a semicolon (;), even if it's the only one.

| Operator | Description                    | Example                                                  |
| -------- | ------------------------------ | -------------------------------------------------------- |
| (none)   | Unconditional - applies to all | `=> color: #ffffff`                                      |
| <        | Less than                      | `Rating < 20 => opacity: 0.4`                            |
| >        | Greater than                   | `Rating > 80 => filter: drop-shadow(0 0 4px gold)`       |
| <=       | Less than or equal             | `Priority <= 3 => border: 2px solid red`                 |
| >=       | Greater than or equal          | `Stars >= 4 => background: gold`                         |
| ==       | Equals (strings or numbers)    | `Type == "restaurant" => color: orange`                  |
| !=       | Not equals                     | `Type != "cafe" => opacity: 0.7`                         |
| (truthy) | Property exists and is truthy  | `Favorite => filter: hue-rotate(45deg)`                  |
| !        | Inverts any condition          | `!isLinked => opacity: 0.5`                              |
| IN       | Value is in a comma list; `tag IN` matches any listed tag | `Type IN "cafe", "bar" => color: orange`     |
| AND      | Both conditions must be true   | `Rating > 80 AND tag:favorite => border: 2px solid gold` |
| OR       | Either condition can be true   | `tag:restaurant OR tag:cafe => color: #e67e22`           |

The left side is a place field: a frontmatter property or query column, a `tag:<name>` check, or the marker's core `icon` and `name` fields. Field names are matched case-insensitively; a query column named `icon` or `name` overrides the core field. `debug: parameters` on the block lists every field its conditions can see.

On the right side, `{PropertyName}` interpolates that place's value into the declaration.

A rule can continue its declarations across following lines. Everything belongs to the current rule until the next line containing `=>`, which starts a new one.

~~~places
iconStyles:
  - Favorite =>
      font-size: 200%;
      opacity: 0.5;
  - Interest Level == "High" =>
      font-size: 175%;
      opacity: 0.33;
~~~

### Precedence and Merging

Rules apply in this order, each overriding the last:

1. Default `iconStyles`/`labelStyles` rules from Places settings
2. Code block or Bases `iconStyles`/`labelStyles` rules
3. Frontmatter `iconStyle`/`labelStyle` properties

Within one source, every matching rule merges and the **last one wins per property**. Put the general rule first and the sharper thresholds after it.

### Default Icon and Label Styles

Global style rules live in Places settings under Default icon styles and Default label styles.

On a self-note map (a block with no `query`, `dataview`, or embedded places, showing the note's own location), `min-zoom`/`max-zoom` declarations in the global defaults are ignored: de-emphasis rules assume a crowd, and zoom-hiding a map's only subject would leave it looking empty. Other default styling (opacity, badges, halos) still applies, and zoom rules written in the block itself apply verbatim.

### CSS Class Assignment

- `condition => .class-name`
- `condition => .class1 .class2`

~~~places
markerRenderer: html
css: |
  .star-overlay::before {
    content: "⭐";
    position: absolute;
    font-size: 200%;
    opacity: 0.5;
    z-index: -1;
  }
iconStyles: Favorite => .star-overlay
~~~

Class rules start with a dot. One line can attach a class while the next writes declarations directly; both kinds of rule can share one block. Classes require HTML markers: the native renderer creates no element to attach them to.

## Icon Styles

Use iconStyles to apply conditional styling to icons based on frontmatter properties:

~~~places
mapProvider: openfreemap
iconStyles:
  - Rating > 80 => font-size: 150%; filter: drop-shadow(0 0 4px gold)
  - Defunct => opacity: 0.4
~~~

### Native Symbol Markers

On the default native renderer, these icon properties are translated to GL layer properties or baked into the marker's style image:

| Property                                                                                                 | Native Translation                         | Example                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| `opacity`                                                                                                | `icon-opacity`                             | `opacity: 0.25;`                        |
| `font-size` (percentage)                                                                                 | `icon-size`                                | `font-size: 200%;`                      |
| `font-size` with zoom stops                                                                              | zoom-interpolated `icon-size`              | `font-size: 25% @z7, 87.5% @z15;`       |
| `content` (+ `content-size`, `content-opacity`, `content-order`, `content-offset-x`, `content-offset-y`) | badge glyph composited into the icon image | `content: "🚫"; content-opacity: 0.75;` |
| `filter: drop-shadow(...)`                                                                               | halo baked into the icon image             | `filter: drop-shadow(0 0 8px white);`   |
| `text-shadow`                                                                                            | halo baked into the icon image             | `text-shadow: 0 0 3px black;`           |
| `min-zoom` / `max-zoom`                                                                                  | zoom filter on the symbol layer            | `min-zoom: 13;`                         |
| `display: none` / `opacity: 0`                                                                           | marker excluded                            | `display: none;`                        |
| `z-index`                                                                                                | label priority (`symbol-sort-key`)         | `z-index: 100;`                         |

Other icon CSS (`transform`, `border`, animations, `calc()` values) requires `markerRenderer: html`:

~~~places
mapProvider: leaflet
iconStyles:
  - Rating => opacity: calc({Rating}/100)
  - Priority > 3 => transform: scale(1.2)
  - Visits => filter: saturate(calc({Visits}*25%))
~~~

### Icon Decorations

`content:` in an iconStyles rule attaches a badge glyph to the marker icon. No pseudo-element required. Companions: `content-size` (percent of icon size, default 100%), `content-opacity` (default 1), `content-order: behind | front` (default behind), and `content-offset-x` / `content-offset-y` for positioning. Offset percentages are relative to the badge glyph itself, which makes `content-offset-x: -100%` the native badge equivalent of `translateX(-100%)`. Pixel offsets are also accepted for small nudges. Zoom-responsive sizing uses `@z` stops with linear interpolation between them:

~~~places
mapProvider: openfreemap
dataview: FROM "Places"
iconStyles:
  - Favorite => content: "⭐"; content-size: 200%; content-opacity: 0.5
  - Featured => content: "✨"; content-offset-x: -100%; content-order: front
  - Defunct => content: "🚫"; content-opacity: 0.75; content-order: front
  - isLinked => filter: drop-shadow(0 0 8px white); font-size: 200%
  - Defunct => font-size: 25% @z7, 87.5% @z15
~~~

## Label Style Properties

### HTML Labels

Any CSS property is supported:

- `color, font-size, opacity`
- `font-weight, font-style, text-decoration`
- `text-shadow, background, border`
- ...

### Native Text Layers

Only these properties are translated:

| CSS Property     | MapLibre Property            | Example                           |
| ---------------- | ---------------------------- | --------------------------------- |
| `color`          | `text-color`                 | `color: #ffffff;`                 |
| `font-size`      | `text-size`                  | `font-size: 16px;`                |
| `opacity`        | `text-opacity`               | `opacity: 0.7;`                   |
| `text-shadow`    | `text-halo-color/width/blur` | `text-shadow: 1px 1px 2px black;` |
| `text-transform` | `text-transform`             | `text-transform: uppercase;`      |
| `letter-spacing` | `text-letter-spacing`        | `letter-spacing: 1px;`            |
| `text-align`     | `text-justify`               | `text-align: center;`             |
| `max-width`      | `text-max-width`             | `max-width: 8em;`                 |
| `z-index`        | `symbol-sort-key`            | `z-index: 10;`                    |

**Default label halo:** default labels get a subtle white halo for legibility. When any label style is provided with `labelStyles` or frontmatter `labelStyle`, the built-in halo is not added; the label uses only the provided style. Add `text-shadow` to keep a halo on styled labels.

**Halo from `text-shadow`:** the blur radius (third value) sets halo softness and the offsets set halo width; a `0 0` shadow uses the blur radius as the width. `text-shadow: 2px 2px 0 black` is a crisp 2px outline, while `text-shadow: 0 0 3px black` is a soft glow.

Native labels ignore `font-weight`, `font-style`, `text-decoration`, `background`, and `border` (the GL engine selects weight and style from its font glyph stack, not from CSS), and `line-height` cannot vary per label.

### Light Labels for Dark Backgrounds

~~~places
mapProvider: mapbox
style: dark
labelStyles:
  - => color: #ffffff; text-shadow: 0 0 1px black
~~~

## Stacking and Label Priority

When labels collide, the map keeps only some of them. Add `z-index` in `iconStyles` or `labelStyles` to set priority. If both icon and label rules set it for the same marker, the label rule wins.

~~~places
mapProvider: leaflet
labelStyles:
  - isLinked => z-index: 100
~~~

Here, linked notes win tight collisions. They also draw above lower-priority markers.

## Zoom Visibility

Use `min-zoom` and `max-zoom` to hide matching markers or labels outside a zoom range.

The rule is chosen when the map renders. Visibility updates at integer zoom levels while zooming. Both renderers support it: native markers use a native zoom filter, while HTML markers use zoom-bucket classes.

~~~places
iconStyles:
  - Rating < 4 => min-zoom: 13
labelStyles:
  - Rating < 4 => min-zoom: 13
~~~

The same zoom fields can live in frontmatter:

~~~yaml
---
Location: 41.408, -75.662
Rating: 3
Marker Min Zoom: 13
Label Min Zoom: 13
Track Min Zoom: 10
Overlay Max Zoom: 14
---
~~~

`Marker Min Zoom` / `Marker Max Zoom` apply to marker icons, `Label Min Zoom` / `Label Max Zoom` apply to labels, and `Track` or `Overlay` zoom fields apply to that note's track or embedded overlay.

## Coloring Markers

A `color:` rule in `iconStyles` tints the marker glyph. Its conditions read the same per-place data as everything else. The color can vary by whatever a query returns:

~~~places
query: SELECT name, location, '➤' icon, wind_speed_10m_max speed FROM weather_daily
iconStyles:
  - speed => color: #38bdf8
  - speed > 10 => color: #ea580c
  - speed > 20 => color: #dc2626
~~~

`color:` applies to text-presentation glyphs: arrows like `➤`, dingbats, geometric shapes like `▲` and `●`. Color emoji such as 🌡️ are bitmap glyphs and ignore `color:` in both renderers. An uncolored text glyph draws solid black, which is heavy at larger icon sizes.

## Rotating Markers

`iconRotation` turns each marker icon. Degrees run clockwise from true north, matching compass bearings, `wind_direction_10m`, and solar azimuths. A bearing column can drive it directly.

A plain number rotates every marker the same way:

~~~places
icon: ➤
iconRotation: 45
~~~

A template rotates each marker by its own data. It resolves against the same per-place context as `labelTemplate`. Any column a query returns is available:

~~~places
query: SELECT name, location, wind_direction_10m FROM weather_hourly
iconRotation: {this.wind_direction_10m}
~~~

**Most arrow glyphs point east, not north.** `➤` and `→` at `iconRotation: 0` point right. A north-referenced bearing reads 90° off. Correct it in the template, which accepts JavaScript expressions:

~~~places
iconRotation: {(this.wind_direction_10m + 270) % 360}
~~~

The same expression handles the other common adjustment: wind direction is reported as the direction the wind comes *from*. `{(this.wind_direction_10m + 180) % 360}` points the arrow the way the wind is blowing.

Values outside 0-359 wrap. A template that does not resolve to a number leaves that marker unrotated and reports it under the block.

## Label Templates

`labelTemplate` rewrites marker labels.

~~~places
mapProvider: mapbox
labelTemplate: {h.before(this.name, '(')}
dataview: FROM "Places"
~~~

The template resolves against the place:

| Placeholder                                | Description                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `{this.name}`                              | The place name                                                                                       |
| `{this.title}`, `{this.filename}`          | The filename without its extension                                                                   |
| `{this.path}`                              | The full vault path                                                                                  |
| `{this.icon}`                              | The marker icon                                                                                      |
| `{this.latitude}`, `{this.longitude}`      | Coordinates                                                                                          |
| `{this.tags}`                              | The note's tags                                                                                      |
| `{this.Rating}`, `{this['Elevation Gain']}` | Any frontmatter property or query column, by display name, lowercase, or spaces-as-underscores form; bracket form for names with spaces |

Available helper functions (h.):

- `h.before(text, delim)` - Text before delimiter ("Coffee Shop, Seattle" with ',' -> "Coffee Shop")
- `h.after(text, delim)` - Text after delimiter
- `h.beforeLast(text, delim)` - Text before last occurrence of delimiter
- `h.afterLast(text, delim)` - Text after last occurrence
- `h.replace(text, search, replacement)` - Replace all occurrences
- `h.regexReplace(text, pattern, replacement)` - Regex replace
- `h.truncate(text, length, suffix)` - Truncate with suffix (default: 200, "...")
- `h.lower(text)`, `h.upper(text)`, `h.capitalize(text)`, `h.trim(text)`

Examples:

~~~places
# Remove city suffix ("Dunder Mifflin (Scranton)" -> "Dunder Mifflin")
labelTemplate: {h.before(this.name, '(')}

# Remove prefix ("Park - Trail" -> "Trail")
labelTemplate: {h.afterLast(this.name, ' - ')}

# JavaScript expression
labelTemplate: {this.name.split(',')[0].trim()}
~~~

## Raw CSS

Use `css` for raw selectors, animations, or pseudo-elements. Marker selectors and data attributes exist only on HTML-rendered markers (Leaflet, or `markerRenderer: html`), since the default native renderer never creates marker DOM; on that renderer, `content:` in an `iconStyles` rule is the equivalent for badges. Popups, legends, containers, and map controls are normal DOM on every renderer. For reusable or vault-wide raw CSS, use an Obsidian CSS snippet.

### CSS Classes

- `.places-marker` - The marker container (holds icon + label)
- `.places-marker-icon` - The icon (emoji)
- `.places-marker-label` - The label (text), Leaflet only; on every other provider use `labelStyles`

### Data Attributes

Properties are automatically added as data attributes on HTML marker elements, enabling CSS selector targeting.

```html
<!-- Generated HTML for a marker -->
<div class="places-marker"
     data-rating="85"
     data-favorite="true"
     data-type="restaurant"
     data-tag-food="true"
     data-tag-visited="true">
  ...
</div>
```

Names arrive kebab-cased: `Interest Level` becomes `data-interest-level`. Tags become data-tag-{tagname} attributes (e.g., tags: [food, visited] -> data-tag-food="true" data-tag-visited="true").

**Where data attributes come from:**
- **Dataview queries**: All frontmatter properties from the source note
- **VaultQuery SQL**: Columns in the query beyond path/title/location/icon/overlay_source/overlay_cache. Use the `places` view, which exposes every single-value frontmatter property as a lowercase column, or add custom columns with JOINs
- **Frontmatter (no query)**: All properties from the note's frontmatter

~~~places
mapProvider: geoapify
markerRenderer: html
dataview: FROM "Places"
css: |
  /* Add explosion effect behind high-interest markers with zoom-responsive sizing */
  .places-marker[data-interest-level="High"] .places-marker-icon::before {
    content: '💥';
    position: absolute;
    transform: translate(-5%, 0%);
    font-size: calc(var(--places-icon-font-size) * (1.5 + 0.25 * clamp(0, (var(--map-zoom) - 8) * 10000 + 1, 1)));
    opacity: 0.33;
    z-index: -1;
  }
~~~

That rule adds a large, faded 💥 behind markers whose `Interest Level` is "High". The size jumps at zoom 8. Below it the badge renders at 150%, at and above it 175%.

`position: absolute` is safe on `::before` and `::after`; the warning is about positioning `.places-marker` itself, the container the map engine anchors to a coordinate. Move that and the icon drifts.

### Zoom-Dependent Styling

Every map container gets `--map-zoom`, an integer such as 6, 11, or 14, updated during zoom animations. Combine it with `calc()` and `clamp()` when marker size should respond to zoom.

~~~places
mapProvider: geoapify
markerRenderer: html
css: |
  .places-marker[data-rating="0 - Avoid"] .places-marker-icon,
  .places-marker[data-defunct="true"] .places-marker-icon {
    /* Scale from 25% to 50% of --places-icon-font-size between z7 and z10 */
    font-size: calc(var(--places-icon-font-size) * clamp(0.25, calc(var(--map-zoom) * 0.0833 - 0.3333), 0.5));
  }

  /* ::before: 25% at z7 -> 87.5% at z15 */
  .places-marker[data-rating="0 - Avoid"] .places-marker-icon::before,
  .places-marker[data-defunct="true"] .places-marker-icon::before {
    content: "🚫";
    position: absolute;
    font-size: calc(var(--places-icon-font-size) * clamp(0.25, calc(var(--map-zoom) * 0.078125 - 0.296875), 0.875));
    opacity: 0.75;
  }
~~~

| Effect                     | Formula                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Linear scaling             | `calc(var(--places-icon-font-size) * clamp(min, calc(var(--map-zoom) * slope - offset), max))`         |
| Step function at zoom 8    | `calc(value * (1.5 + 0.25 * clamp(0, (var(--map-zoom) - 8) * 10000 + 1, 1)))`                          |
| Gentle scaling (80-150%)   | `calc(var(--places-icon-font-size) * clamp(0.8, calc(var(--map-zoom) * 0.0875 - 0.35), 1.5))`          |
| Compact scaling (25-87.5%) | `calc(var(--places-icon-font-size) * clamp(0.25, calc(var(--map-zoom) * 0.078125 - 0.296875), 0.875))` |

## Per-Note Styling

Override icon and label styles for individual notes using frontmatter properties.

| Property    | Description                                  | Example                                 |
| ----------- | -------------------------------------------- | --------------------------------------- |
| trackDefaultVisibility | Show or hide this note's overlay on initial map load, overriding the block's `track.defaultVisibility` | visible, hidden |
| iconStyle   | Declarations applied to the icon             | "opacity: 0.8; font-size: 150%"         |
| labelStyle  | Declarations applied to the label            | "color: purple; text-shadow: 0 0 2px black" |

Frontmatter styles are translated the same way as `iconStyles`/`labelStyles` rules.

```yaml
---
Location: 41.408, -75.662
iconStyle: "opacity: 0.8; font-size: 150%"
labelStyle: "color: purple; text-shadow: 0 0 2px black"
Rating: 95
Favorite: true
Type: restaurant
---
```

## Highlighting Linked Notes

SQL computed columns can style markers by whether they are linked from the current note.

~~~places
mapProvider: stadia
height: 500px
radius: 15mi from 41.408, -75.662
query: SELECT p.*,
  CASE WHEN p.path IN ({this.outgoingLinks}) THEN 'true' ELSE 'false' END AS isLinked
  FROM places p
  WHERE p.path IN ({this.outgoingLinks})
    OR p.path LIKE '90 - Locations/%'
iconStyles:
  - isLinked => filter: drop-shadow(1px 0 0 #FFF) drop-shadow(-1px 0 0 #FFF) drop-shadow(0 1px 0 #FFF) drop-shadow(0 -1px 0 #FFF) drop-shadow(0 0 8px rgba(0, 0, 0, 0.8)); font-size: 200%; z-index: 100
  - !isLinked => opacity: 0.5
labelStyles:
  - !isLinked => opacity: 0.5
~~~

The `CASE WHEN` creates an `isLinked` column that is `'true'` for notes linked from the current file and `'false'` otherwise. `{this.outgoingLinks}` expands to a list of file paths linked from the current note.

## Track Styling

Customize the appearance of individual tracks/routes using frontmatter properties or embedded place syntax.

| Property         | Description                   | Example Values                       |
| ---------------- | ----------------------------- | ------------------------------------ |
| `trackStyle` | Styling shorthand (see below) | "4 dashed #39e657; 8 solid #000 0.3" |

### Track Style Syntax

The `trackStyle` property defines main line and optional outline styling in a single property:

- Format: "weight style color [opacity]; outline-weight outline-style outline-color [outline-opacity]"
- No semicolon = no outline
- With semicolon = outline enabled
- Style can be "solid" or "dashed"
- Opacity is optional (defaults to 1)

```yaml
---
Location: 41.408, -75.662
Overlay Source: <compressed track data>
trackStyle: "4 solid #e63946 0.9; 8 solid #000000 0.5"
---
```

### Polyline Coloring Modes

Use `track.colorBy` to automatically color polylines based on data:

| Mode        | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `none`      | Single solid color (default)                                      |
| `elevation` | Color by absolute elevation (blue=low to white=high)              |
| `grade`     | Color by terrain steepness (blue=downhill, gray=flat, red=uphill) |
| `speed`     | Color by speed, averaged over `speedWindow` (needs GPX timestamps) |
| `pace`      | Color by pace, same data as speed with the ramp inverted           |

~~~places
mapProvider: leaflet
track:
  colorBy: grade
  gradeWindow: 100ft
~~~

Individual notes can override the code block setting using the `trackColorBy` frontmatter property:

```yaml
---
trackColorBy: elevation
---
```

`track.gradeWindow` is the span the rolling grade is measured over. Smaller values show more detail, larger values smooth out noise. It takes a distance (`100ft`, `50m`, `0.1mi`) or, on charts, a time (`10min`). `track.speedWindow` does the same for speed and pace, defaulting to `200m`; a time window such as `30s` reads better across stops, where a distance window spans the whole pause. Both default from the matching settings in Places settings, and `gradeDistance:` is still accepted as the older spelling of `gradeWindow:` (an unlabelled number of feet).
