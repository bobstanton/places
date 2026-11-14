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

| Operator | Description                                               | Example                                                  |
| -------- | --------------------------------------------------------- | -------------------------------------------------------- |
| (none)   | Unconditional - applies to all                            | `=> color: #ffffff`                                      |
| <        | Less than                                                 | `Rating < 20 => opacity: 0.4`                            |
| >        | Greater than                                              | `Rating > 80 => filter: drop-shadow(0 0 4px gold)`       |
| <=       | Less than or equal                                        | `Priority <= 3 => border: 2px solid red`                 |
| >=       | Greater than or equal                                     | `Stars >= 4 => background: gold`                         |
| ==       | Equals (strings or numbers)                               | `Type == "restaurant" => color: orange`                  |
| !=       | Not equals                                                | `Type != "cafe" => opacity: 0.7`                         |
| (truthy) | Property exists and is truthy                             | `Favorite => filter: hue-rotate(45deg)`                  |
| !        | Inverts any condition                                     | `!isLinked => opacity: 0.5`                              |
| IN       | Value is in a comma list; `tag IN` matches any listed tag | `Type IN "cafe", "bar" => color: orange`                 |
| AND      | Both conditions must be true                              | `Rating > 80 AND tag:favorite => border: 2px solid gold` |
| OR       | Either condition can be true                              | `tag:restaurant OR tag:cafe => color: #e67e22`           |

The left side is a place field: a frontmatter property or query column, a `tag:<name>` check, or the marker's core `icon` and `name` fields. Field names are matched case-insensitively; a query column named `icon` or `name` overrides the core field. `debug: parameters` on the block lists every field its conditions can see.

On the right side, `{PropertyName}` interpolates that place's value into the declaration.

A rule can continue its declarations across following lines when the rules are written as a YAML text block (`|`). A line containing `=>` starts a new rule.

~~~places
iconStyles: |
  Favorite =>
    font-size: 200%;
    opacity: 0.5;
  Interest Level == "High" =>
    font-size: 175%;
    opacity: 0.33;
~~~

### Precedence and Merging

Rules apply in this order, each overriding the last:

1. Default `iconStyles`/`labelStyles` rules from Places settings
2. Code block or Bases `iconStyles`/`labelStyles` rules
3. Query `iconStyles`/`labelStyles` columns
4. Note `iconStyles`/`labelStyles` properties

Within one source, every matching rule merges and the **last one wins per property**. Put the general rule first and the sharper thresholds after it.

### Default Icon and Label Styles

Global style rules live in Places settings under Default icon styles and Default label styles.

On a self-note map (a block with no `query`, `dataview`, or `places` list, showing the note's own location), `min-zoom`/`max-zoom` declarations in the global defaults are ignored: de-emphasis rules assume a crowd, and zoom-hiding a map's only subject would leave it looking empty. Other default styling (opacity, badges, halos) still applies, and zoom rules written in the block itself apply verbatim.

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

| Property                                                                                                 | Native Translation                         | Example                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `opacity`                                                                                                | `icon-opacity`                             | `opacity: 0.25;`                                                          |
| `font-size` (percentage)                                                                                 | `icon-size`                                | `font-size: 200%;`                                                        |
| `font-size` with zoom stops                                                                              | zoom-interpolated `icon-size`              | `font-size: 25% @z7, 87.5% @z15;`                                         |
| `content` (+ `content-size`, `content-opacity`, `content-order`, `content-offset-x`, `content-offset-y`) | badge glyph composited into the icon image | `content: "🚫"; content-opacity: 0.75;`                                    |
| `filter: drop-shadow(...)`                                                                               | halo baked into the icon image             | `filter: drop-shadow(0 0 8px white);`                                     |
| `text-shadow`                                                                                            | halo baked into the icon image             | `text-shadow: 0 0 3px black;`                                             |
| `background-color`, `border`, `border-radius`                                                            | backing box baked into the icon image      | `background-color: #2563eb; border: 2px solid white; border-radius: 50%;` |
| `min-zoom` / `max-zoom`                                                                                  | zoom filter on the symbol layer            | `min-zoom: 13;`                                                           |
| `display: none` / `opacity: 0`                                                                           | marker excluded                            | `display: none;`                                                          |
| `z-index`                                                                                                | label priority (`symbol-sort-key`)         | `z-index: 100;`                                                           |

`iconImage` replaces the glyph with a picture: a vault path, the absolute path of a file outside the vault (what VaultQuery returns for an external folder), a URL, or a per-place template such as `{this.path}`. The picture is cropped to fill the marker, a square and unbordered by default. `iconImageStyles` frames it, in the same rule syntax as `iconStyles`: `background-color`, `border`, and `border-radius` apply, and `border-radius: 50%` rounds it. Glyph rules never frame a picture, so a `border` written for emoji markers leaves the photographs alone. A picture that has not decoded yet, or a file that is missing, leaves that place its glyph. Both renderers draw it; the native renderer bakes it into the marker image, and each picture is its own image rather than one shared by every place with the same glyph.

A backing box draws behind the glyph on both renderers. `border-radius: 50%` is a circle, a pixel radius rounds a square, and the border draws inside the box. Its size follows the HTML marker's own proportion, so the glyph sits inside it at any `font-size`. `filter: drop-shadow` and `text-shadow` still apply to the glyph, not to the box.

~~~places
iconStyles:
  - => background-color: #2563eb; border: 2px solid white; border-radius: 50%
  - Rating > 80 => background-color: gold
~~~

Other icon CSS (`transform`, animations, `calc()` values) requires `markerRenderer: html`:

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

**Default label halo:** default labels get a subtle white halo for legibility. When any label style is provided with `labelStyles` or note `labelStyles`, the built-in halo is not added; the label uses only the provided style. Add `text-shadow` to keep a halo on styled labels.

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

The same zoom fields work in the code block, as query columns, or as individual note properties:

~~~yaml
---
Location: 41.408, -75.662
Rating: 3
markerMinZoom: 13
labelMinZoom: 13
trackMinZoom: 10
overlayMaxZoom: 14
---

~~~

`markerMinZoom` / `markerMaxZoom` apply to marker icons, `labelMinZoom` / `labelMaxZoom` apply to labels, and `trackMinZoom` / `trackMaxZoom` or `overlayMinZoom` / `overlayMaxZoom` apply to tracks or embedded overlays. The most specific value wins for each bound: query row, note, then block. Style-rule zoom declarations also constrain the resulting range.

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
iconRotation: 45
places:
  - Location: 41.408, -75.662
    Name: Rotated arrow
    icon: ➤
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

| Placeholder                                 | Description                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `{this.name}`                               | The place name                                                                                                                          |
| `{this.title}`, `{this.filename}`           | The filename without its extension                                                                                                      |
| `{this.path}`                               | The full vault path                                                                                                                     |
| `{this.icon}`                               | The marker icon                                                                                                                         |
| `{this.latitude}`, `{this.longitude}`       | Coordinates                                                                                                                             |
| `{this.tags}`                               | The note's tags                                                                                                                         |
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

Choose one template for each block:

~~~places
# Remove city suffix ("Dunder Mifflin (Scranton)" -> "Dunder Mifflin")
labelTemplate: {h.before(this.name, '(')}
~~~

~~~places
# Remove prefix ("Park - Trail" -> "Trail")
labelTemplate: {h.afterLast(this.name, ' - ')}
~~~

~~~places
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
- **VaultQuery SQL**: Selected data columns plus metadata from the referenced note. Query values win for ordinary data; query setting columns override note presentation properties. Serialized overlay data and note content are excluded from metadata. Both `places` and `places_tracks` expose all indexed scalar properties
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

## Note and query overrides

Notes use individual frontmatter properties. Query columns use **exactly the same names**, including dots: `track.colorBy`, `track.defaultVisibility`, and so on. There is no `places:` or `settings:` container and no JSON column. Code blocks keep the corresponding nested settings.

Precedence is **query rows > note properties > code block > global defaults**. Missing or null values inherit. Explicit `false`, `0`, and empty strings are preserved where the setting supports them. Style rules append in block, note, and query order; the last matching declaration wins. Explicit popup content lists replace the inherited list. Renderer option-only overrides retain the inherited content.

```yaml
---
Location: 41.408, -75.662
Rating: 95
track.colorBy: elevation
track.defaultVisibility: visible
track.style: "4 solid red"
iconStyles:
  - '=> opacity: 0.8; font-size: 150%'
labelStyles:
  - '=> color: purple; text-shadow: 0 0 2px black'
popup.content.renderer: knap
popup.content.options.templateFile: Templates/Rating.knap.md
---
```

A query can supply different settings per row using ordinary expressions and quoted aliases:

~~~places
query: |
  SELECT path, title, location, icon, overlay_source, overlay_cache,
         'grade' AS "track.colorBy",
         CASE WHEN rating >= 4 THEN 'visible' ELSE 'hidden' END AS "track.defaultVisibility",
         'knap' AS "popup.content.renderer",
         'Templates/Rating.knap.md' AS "popup.content.options.templateFile"
  FROM places_tracks
track:
  colorBy: none
  defaultVisibility: hidden
~~~

See `places-query-help` for indexed column names and for returning per-place templates without resolving their placeholders before SQL runs.

Both `places` and `places_tracks` include all indexed property columns. A returned `path` also loads that note's presentation properties and metadata, even with a narrow projection. The query must still return `location` and any icon or overlay geometry it needs. Synthetic rows without `path` can use the same setting columns.

| Per-place setting                                                                     | Effect                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `track.colorBy`                                                                       | `none`, `elevation`, `grade`, `speed`, or `pace`                                           |
| `track.defaultVisibility`                                                             | Initial track state: `visible` or `hidden`                                                 |
| `track.style`                                                                         | Track width, dashes, color, opacity, and optional outline style; unspecified parts inherit |
| `track.outline`                                                                       | Show or hide the track outline                                                             |
| `track.labels.visibility`                                                             | `all`, `none`, or a selection of `start`, `midpoint`, `end`                                |
| `track.labels.start`, `track.labels.midpoint`, `track.labels.end`                     | Individual path-label templates; empty text suppresses a slot                              |
| `labelTemplate`                                                                       | Marker label template                                                                      |
| `iconRotation`                                                                        | Clockwise degrees or a per-place template                                                  |
| `iconImage`                                                                           | Picture drawn as the marker: a vault path, a URL, or a per-place template                  |
| `iconImageStyles`                                                                     | Conditional rules framing that picture; the same syntax as `iconStyles`                    |
| `iconStyles`, `labelStyles`                                                           | The same conditional rule lists used by the code block                                     |
| `popup.content`                                                                       | `note` includes the note body; `none` suppresses the body                                  |
| `popup.content.renderer`, `popup.content.options.templateFile`                        | Renderer selection and external Knap template file                                         |
| `popup.content.0.renderer`, `popup.content.0.options.templateFile`, `popup.content.1` | Ordered sections using numeric positions; the last example accepts `note`                  |
| `markerMinZoom`, `markerMaxZoom`                                                      | Marker icon zoom limits                                                                    |
| `labelMinZoom`, `labelMaxZoom`                                                        | Marker label zoom limits                                                                   |
| `trackMinZoom`, `trackMaxZoom`                                                        | Track zoom limits                                                                          |
| `overlayMinZoom`, `overlayMaxZoom`                                                    | Embedded-overlay zoom limits; also constrain note tracks                                   |

For a custom popup, save `Rating: {{ rating }}` in `Templates/Rating.knap.md` and select the `knap` renderer. For multiple sections, use separate properties:

```yaml
popup.content.0.renderer: knap
popup.content.0.options.templateFile: Templates/Rating.knap.md
popup.content.1: note
```

A note or a `places:` entry also accepts the nested `popup:` form the code block uses. Setting it together with `popup.content` properties is an error:

~~~places
places:
  - Location: 41.408, -75.662
    Name: Dunder Mifflin Scranton
    phone: 570-555-0100
    popup:
      content:
        - renderer: knap
          options:
            templateFile: Templates/Front desk.knap.md
~~~

Save `**Front desk:** {{ phone }}` in `Templates/Front desk.knap.md`. The same setting names work as SQL aliases. Missing or null indexed sections are omitted. Use either a single section or numbered sections. `popup.content: none` clears the body. `iconStyles` and `labelStyles` accept note lists or query text with newline-separated rules; numbered properties such as `iconStyles.0` also work.

Popup overrides resolve against the place's data and query row. Explicit content replaces the inherited list. Option-only overrides retain its sections. A note section needs a linked note; Knap templates also work on synthetic query rows. Invalid settings report an error rather than silently dropping the marker.

Map-wide settings stay in the block: providers, dimensions, camera, clustering, `showLabels`, search and query controls, terrain, legend, route generation, heatmap configuration, track details, direction arrows, and grade/speed averaging. In particular, `showLabels: false` still hides all labels even when a note supplies templates.

### Renderer options

Each renderer section accepts `options`:

```yaml
popup:
  content:
    renderer: image.preview
    options:
      fields: [captured, camera_model]
```

The same paths apply to note properties and query columns:

```sql
'image.preview' AS "popup.content.renderer",
'captured, camera_model' AS "popup.content.options.fields"
```

An option-only override retains the inherited renderer and content list:

```sql
'camera_model' AS "popup.content.options.fields"
```

For multiple sections, `popup.content.1.options.fields` targets the second section. Option mappings merge by key; lists replace. Missing or null options inherit. Explicit content replaces the list and its options; `popup.content: none` clears the body. Option-only overrides require an inherited renderer at the specified position and cannot share a layer with replacement sections.

`image.preview` accepts `options.fields` as a list or comma-separated text. Fields appear in order; missing values are omitted. Omission retains the default metadata. `[]` in YAML or an empty SQL string hides all metadata while retaining the image. Supported image fields include `description`, `captured`, `captured_local`, `camera_make`, `camera_model`, `lens_model`, `iso`, `exposure_time`, `exposure_time_text`, `f_number`, `focal_length`, and `focal_length_35mm`. Other selected columns display as labeled values.

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

Use the `track.style` note property or query column, or the nested `track.style` setting in the code block. It controls line width, dashes, color, opacity, and an optional outline.

### Track Style Syntax

Separate the line and optional outline styles with a semicolon:

`weight style color [opacity]; outline-weight outline-style outline-color [outline-opacity]`

- `weight` is the line width in pixels and must be positive.
- `style` is `solid` or `dashed`.
- `color` accepts CSS names such as `red` and 3/4/6/8-digit hex values such as `#e63946`.
- `opacity` ranges from `0` (transparent) to `1` (opaque). If omitted, it keeps the imported value or defaults to `0.9` for the line and `1` for the outline.
- Unspecified style parts inherit from less specific settings or the imported geometry. Leaving out the semicolon preserves the inherited outline policy. Use `track.outline: false` to disable it. The line and outline can use different dash styles.

Color names and `solid`/`dashed` ignore capitalization. Invalid values produce an error.

```yaml
track.style: '4 solid #e63946 0.9; 8 solid #000000 0.5'

```

### Track Coloring Modes

Use `track.colorBy` to automatically color tracks based on data:

| Mode        | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `none`      | Single color (dashed by default)                                  |
| `elevation` | Color by absolute elevation (blue=low to white=high)              |
| `grade`     | Color by terrain steepness (blue=downhill, gray=flat, red=uphill) |
| `speed`     | Averaged over `speedWindow`                                       |
| `pace`      | Minutes per mile or kilometer, averaged over `speedWindow`        |

~~~places
mapProvider: leaflet
track:
  colorBy: grade
  gradeWindow: 100ft
~~~

The `track.colorBy` note property overrides block coloring when the query omits it:

```yaml
---
track.colorBy: elevation
---

```

`track.gradeWindow` measures rolling grade over a distance, defaulting to `100ft`. Smaller values show more detail; larger values smooth out noise. Use `100ft`, `50m`, or `0.1mi` in maps. Charts use the root `gradeWindow:` setting and also accept time windows such as `10min`.

`track.speedWindow` averages speed and pace over a distance or time, defaulting to `200m`. A time window such as `30s` limits how much of a stop contributes to the average. Charts use the root `speedWindow:` setting.

`gradeDistance:` accepts a number of feet under `track:` for maps and at the root for charts. `gradeWindow` takes precedence when both are present.
