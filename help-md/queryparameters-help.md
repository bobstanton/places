---
id: queryparameters-help
title: Query Parameters Help
---

# Interactive query parameters

`queryParameters` adds UI controls to interact with the map. Reference each parameter as `{parameter.name}` in the query or in any other block setting; changing a control re-renders the affected data in place.

~~~places
height: 450px
query:
  SELECT * FROM places
  WHERE path LIKE '%Scranton%'
  LIMIT {parameter.limit}
queryParameters:
  - name: limit
    type: int
    control: slider
    min: 1
    max: 40
    default: 10
    label: Places shown
    width: 50%
~~~

## Parameter settings

| Setting          | Description                                                                                                                                                                                                         | Examples                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| name             | Required. Referenced as `{parameter.name}` in the query or any other block setting                                                                                                                                  | limit, kind                                                                                                                    |
| type             | Value type                                                                                                                                                                                                          | **string**, int, float, date, datetime, time, boolean, enum, list, location                                                    |
| control          | Control kind. Inferred from the type when omitted: numeric types with `min`/`max` get a slider, enums a dropdown, lists a multiselect, booleans a toggle, strings with `options` a combobox                         | slider, range, number, text, combobox, dropdown, segmented, toggle, date, datetime, time, multiselect, location, stops, custom |
| default          | Initial value. A range control takes `20, 60` or `[20, 60]`; a `list` parameter takes a list, or `all` to start with every option selected                                                                          | 10, `[20, 60]`, all                                                                                                            |
| min / max / step | Numeric bounds and step; `range: 0, 100` is shorthand for min and max                                                                                                                                               | 0, 100, 5                                                                                                                      |
| scale            | Spacing of a range control's values along its slider. `log` spaces them by ratio, giving values near `min` most of the slider                                                                                       | **linear**, log                                                                                                                |
| showValue        | Whether a `range` control shows its min-max readout beside the slider                                                                                                                                               | **true**, false                                                                                                                |
| width            | Fixed lengths size the input; a percentage sizes the complete parameter relative to the control strip. Percentages apply to every control; fixed lengths have no effect on `toggle`, `segmented`, and `multiselect` | 240px, 18rem, 30ch, 50%                                                                                                        |
| options          | Allowed values for `enum`/`list`; suggestions for a `combobox`                                                                                                                                                      | `- 🍕`<br>`- 🍝`                                                                                                                 |
| optionsQuery     | VaultQuery SQL whose first column supplies the options at render time, in query order; `{this.*}` is supported. On a range control it supplies the limits instead: the column's smallest and largest number         | SELECT DISTINCT icon FROM places ORDER BY icon                                                                                 |
| label            | Control caption. Defaults to the name                                                                                                                                                                               | Places shown                                                                                                                   |
| play             | Auto-advance interval: `true` is 1000 ms, a number is milliseconds; renders a play/pause button. Sliders step from min to max and wrap; `dropdown`, `segmented`, and `custom` controls cycle their options          | true, 500                                                                                                                      |
| showOnMap        | For `location` or `control: stops`, show the current value as one or more map markers                                                                                                                               | true, false                                                                                                                    |
| icon / icons     | Marker glyph for every value, or a positional list for stops. Declaring either also enables `showOnMap`; a referenced note's icon is used when neither is supplied                                                  | 📍, `[1️⃣, 2️⃣, 🏁]`                                                                                                             |
| render / mount   | JavaScript for `control: custom`, described below                                                                                                                                                                   |                                                                                                                                |

## Range controls

`range` is a dual-ended slider exposing `{parameter.name.min}` and `{parameter.name.max}`. The query runs as a handle moves, throttled, and again on release:

~~~places
query:
  SELECT p.* FROM places p JOIN notes n ON n.path = p.path
  WHERE n.size BETWEEN {parameter.size.min} AND {parameter.size.max}
queryParameters:
  - name: size
    type: int
    control: range
    min: 0
    max: 10000
~~~

An `optionsQuery` on a range supplies its limits instead of declared `min` and `max`: the smallest and largest number in the first column. The default is the full span unless declared. `scale: log` spaces values by ratio: the first step above `min` takes as much of the slider as each further tenfold.

~~~places
query: |
  SELECT * FROM places
  WHERE convert_distance(distance, 'mi') BETWEEN {parameter.distance.min} AND {parameter.distance.max}
queryParameters:
  - name: distance
    type: float
    control: range
    scale: log
    step: 0.5
    label: Distance (mi)
    optionsQuery: SELECT convert_distance(distance, 'mi') FROM places
~~~

A limits query that references an earlier parameter rebuilds the control with the new limits when that parameter changes. A selection outside the new limits is clamped to them.

The readout beside the slider shows both ends at the step's precision and keeps the width of its widest possible text, whatever the current values. `showValue: false` omits it.

## List parameters

`list` formats as a quoted SQL sequence for `IN (...)`. It substitutes `NULL` when nothing is selected:

~~~places
query: SELECT * FROM places WHERE icon IN ({parameter.icons})
queryParameters:
  - name: icons
    type: list
    optionsQuery: SELECT DISTINCT icon FROM places ORDER BY icon
    default: [🍕]
~~~

`default: all` starts with every option selected - including options an `optionsQuery` only supplies at render time, and it follows the options when a cascading query changes them. Deselect from there:

~~~places
queryParameters:
  - name: icons
    type: list
    optionsQuery: SELECT DISTINCT icon FROM places ORDER BY icon
    default: all
~~~

## Map view placeholders

`query` and `optionsQuery` accept these numeric placeholders without a `queryParameters` declaration.

| Placeholder              | Value                                                      |
| ------------------------ | ---------------------------------------------------------- |
| `{map.zoom}`             | Current zoom, including fractional zoom levels             |
| `{map.center.latitude}`  | Camera center latitude in degrees                          |
| `{map.center.longitude}` | Camera center longitude in degrees, from -180 up to 180    |
| `{map.bearing}`          | Rotation clockwise from north in degrees, from 0 up to 360 |
| `{map.pitch}`            | Camera tilt in degrees; 0 looks straight down              |
| `{map.width}`            | Viewport width in CSS pixels                               |
| `{map.height}`           | Viewport height in CSS pixels                              |
| `{map.south}`            | Southern viewport bound in degrees                         |
| `{map.west}`             | Western viewport bound in degrees                          |
| `{map.north}`            | Northern viewport bound in degrees                         |
| `{map.east}`             | Eastern viewport bound in degrees                          |
| `{map.ready}`            | 1 when viewport bounds are available; otherwise 0          |

Queries refresh after the map settles when a referenced value changes. Refreshes preserve the camera.

Before the map exists, the bounds cover the whole world, `{map.ready}` is `0`, and the other values resolve to SQL `NULL`. Use `COALESCE({map.zoom}, 7)` to supply an initial fallback, or `{map.ready} = 1` to wait for a live viewport. Use numeric placeholders without SQL quotes.

Views crossing the antimeridian have west greater than east; match longitudes on either side of the date line in that case.

A range whose limits query includes viewport conditions recalculates its limits as the map moves.

For custom controls, persist clamped selections in `mount` with `param.setValue(..., { redraw: false })`.

These placeholders are available through the MapLibre and Leaflet providers. Leaflet reports bearing and pitch as `0`. Bounds describe a geographic rectangle; filtering note locations tests marker positions, not track intersections.

## Note properties

`{note.*}` substitutes the containing note's own frontmatter into a block's settings. One property can drive several blocks in the same note. A trip note with

~~~yaml
---
Location: 41.4089, -75.6624
StartDate: 2027-01-01
Days: 7
---
~~~

feeds a map, a weather block and a tide block without repeating the coordinates in each:

~~~places
height: 400px
radius: "10 mi from {note.Location}"
query: SELECT * FROM places
~~~

~~~places-weather
location: {note.Location}
startDate: {note.StartDate}
days: {note.Days}
mode: daily
~~~

`{note.*}` resolves in every block type that Places renders (maps, charts, heatmaps, weather, tides, solar) and in every setting except the query languages. Values substitute verbatim: dates format as written (`2027-01-01`), lists join as comma-separated text, and a missing property is left visible and reported rather than silently blanked.

### note versus this

`{this.*}` already means two other things. Note properties get their own prefix:

| Placeholder                                                                                              | Resolved against                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `{note.*}`                                                                                               | the containing note's frontmatter, in settings |
| `{this.*}` in `query:` / `optionsQuery:`                                                                 | the current note, by VaultQuery                |
| `{this.*}` in `labelTemplate`, the other label templates, and per-place templates such as `iconRotation` | the place, feature, route, or waypoint         |

`{note.*}` is deliberately not substituted into `query:`, `optionsQuery:`, `dataview:`, or a nested `routes[].query`: those keep their existing `{this.*}` handling, which quotes and escapes values for SQL. Use `{this.*}` inside a query and `{note.*}` everywhere else.

Editing a property re-renders the blocks that reference it.

## Parameters in other settings

`{parameter.*}` placeholders resolve in every block setting: overlay entries, directions, isochrones, radius, and css included. Values substitute verbatim there, with booleans as `true`/`false` and `list` parameters as comma-separated text; SQL quote escaping applies to the query alone.

A placeholder can be an expression over the parameter value. An overlay entry's `visible:` driven by a multiselect: `visible: {parameter.layers.includes("Trails")}`.

~~~places
height: 450px
overlays:
  - path: {parameter.track}
queryParameters:
  - name: track
    type: enum
    optionsQuery: SELECT path FROM places WHERE path LIKE '%Morning Run%' ORDER BY path
    label: Track
~~~

An overlay's `visible:` reads a boolean parameter: a toggle per overlay shows and hides each entry. A `true`/`false` value substitutes directly; a `list` parameter drives several entries from one multiselect with `{parameter.name.includes("Option")}`.

~~~places
queryParameters:
  - name: monday
    type: boolean
    default: true
    label: Monday
  - name: tuesday
    type: boolean
    default: true
    label: Tuesday
overlays:
  - path: 91 - Random Routes for Heatmaps/Morning Run - Monday.md
    visible: {parameter.monday}
  - path: 91 - Random Routes for Heatmaps/Morning Run - Tuesday.md
    visible: {parameter.tuesday}
~~~

## Stop lists

A `list` parameter with `control: stops` edits an ordered, growable list: one text row per entry with add and remove buttons. **Reset stops** restores the currently declared `default` list, including defaults changed while editing the note. Options from `options` or an `optionsQuery` are per-row suggestions, not restrictions, and empty rows are dropped.

In the other settings, a YAML list item that is exactly one placeholder expands into one item per entry. A stops parameter feeds `waypoints:` or `centers:` directly. Entries resolve scalar parameter references: a row containing `{parameter.end}` expands to that parameter's current value. A `location` parameter can serve as a map-settable stop. References to other list parameters join as comma-separated text instead of expanding.

~~~places
routeProvider: openrouteservice
directions:
  - mode: drive
    routes:
      - waypoints:
          - {parameter.stops}
queryParameters:
  - name: stops
    type: list
    control: stops
    default: ["[[Dunder Mifflin Scranton]]", "[[Poor Richards]]"]
    optionsQuery: SELECT '[[' || title || ']]' FROM places ORDER BY title
    label: Stops
~~~

In the query, the same parameter still formats as a quoted SQL sequence for `IN (...)`. Entries substitute verbatim, brackets included: wikilink-shaped stops match with the same wrapping (`WHERE '[[' || title || ']]' IN ({parameter.stops})`); stops kept as plain titles match `title` directly and still resolve as waypoints.

## Cascading options

An `optionsQuery` may reference parameters declared earlier in the list. Changing the upstream control re-runs the dependent query and rebuilds its options; a selection that falls out of the new options resets to the first one.

~~~places
query: SELECT * FROM places WHERE icon = '{parameter.icon}'
queryParameters:
  - name: folder
    type: enum
    optionsQuery: SELECT DISTINCT substr(path, 1, instr(path, '/') - 1) folder FROM places ORDER BY folder
  - name: icon
    type: enum
    optionsQuery: SELECT DISTINCT icon FROM places WHERE path LIKE '{parameter.folder}%' ORDER BY icon
~~~

## Location parameters

A `location` parameter holds a `latitude, longitude` value or a named coordinate in the form `Name: latitude, longitude`. The control is a text input, and the map's context menu gains a `Set <label> here` entry that writes the clicked coordinate. Names are preserved when the parameter is used as a direction waypoint or isochrone center.

~~~places
height: 450px
radius: 5 from {parameter.center}
query: SELECT * FROM places
queryParameters:
  - name: center
    type: location
    default: 41.408, -75.662
    label: Center
~~~

`showOnMap: true` displays the parameter's current location as a marker. `icon` sets its glyph and enables `showOnMap`. Brace placeholders in settings and list items do not require quotes.

~~~places
height: 450px
isochrones:
  - mode: drive
    provider: mapbox
    centers:
      - {parameter.center}
    ranges:
      - 30 min
      - 60 min
queryParameters:
  - name: center
    type: location
    default: 41.408, -75.662
    label: Center
    icon: 🎯
~~~

For a `list` parameter using `control: stops`, `icon` applies to every stop and `icons` assigns glyphs positionally; missing entries fall back to the referenced note's icon and then 📍.

## Selection as a parameter

`selection.itemParameter` names a parameter that a popup's Select action sets to the selected place or track path (its name for manual places). `selection.pointParameter` stores the exact selected or playback coordinate. `selection.channel` optionally names the typed channel exposed to installed Places extensions. Both parameters are shared note parameters. A map, elevation chart, or control can drive the other consumers.

~~~places
height: 450px
query: SELECT * FROM places WHERE path LIKE '%Scranton%'
selection:
  itemParameter: selected
  pointParameter: selectedPoint
  channel: primary
queryParameters:
  - name: selected
    type: string
    label: Selected place
  - name: selectedPoint
    type: location
    label: Selected point
~~~

Track-specific configuration may instead use `track.selection.trackParameter` and `track.selection.pointParameter`, keeping a track selection separate from a general place selection.

### The map's viewport as parameters

`selection.viewportParameter` names the note parameters a map publishes for what it is showing. A base name of `view` publishes `viewNorth`, `viewSouth`, `viewEast`, `viewWest` and `viewZoom`, and republishes them whenever the map settles after a pan or zoom. Any block in the note reads them as `{parameter.viewNorth}` and re-runs when they change - which is how a list or a gallery follows the map.

~~~places
query: SELECT path, basename AS title, location, '📷' AS icon FROM image_files WHERE location IS NOT NULL
iconImage: "{this.path}"
selection:
  viewportParameter: view
~~~

They are values, not controls: nothing renders them in a parameter strip, and a `places-parameters` block declaring the same name earlier in the note keeps its own. Inside the map's own block, `{map.north}` and its fellows say the same thing without publishing anything.

## Note-scoped parameters

A `places-parameters` block declares parameters once for the whole note and renders their controls where it sits. Every parameter-consuming block in the note resolves them; block-local declarations shadow note-scoped ones by name. Changing a control re-renders the note's consuming blocks.

~~~places-parameters
queryParameters:
  - name: days
    type: int
    control: slider
    min: 1
    max: 30
    default: 7
    label: Days
~~~

### Shared date ranges

Use the conventional `startDate` and `endDate` names to let weather, tide, solar, map, and extension blocks share one date window. Any setting may consume the values, including extension block settings such as `startDate:` and `endDate:`.

~~~places-parameters
queryParameters:
  - name: startDate
    type: date
    default: 2026-07-01
    label: Start
  - name: endDate
    type: date
    default: 2026-07-07
    label: End
~~~

~~~places-weather
location: 41.408, -75.662
startDate: {parameter.startDate}
endDate: {parameter.endDate}
~~~

## Data blocks

`places-chart`, `places-heatmap`, `places-similar`, and `places-compare` blocks resolve `{parameter.*}` in their settings the same way and render their control strip above the content. Value changes re-render the block.

~~~places-chart
chartType: elevation
track1: {parameter.track}
queryParameters:
  - name: track
    type: enum
    optionsQuery: SELECT path FROM places WHERE path LIKE '%Scranton%' ORDER BY path
    label: Track
~~~

## Placement and behavior

`queryParametersPosition` places the controls `below` the map (default), `above` it, or `floating` on the map itself. Data blocks and blocks from installed extensions honor the same key, defaulting to `above`; having no map, they render a `floating` strip over their own content.

`queryParametersLayout: vertical` stacks the controls one per line instead of flowing them along a row. Labels share a minimum column to line the controls up; override it with `--places-query-param-label-width` in a CSS snippet or the block's `css:` setting.

A floating strip overlays the map and always carries a collapse toggle. Collapsed, it shrinks to a single icon chip and gives the map back the space. `queryParametersCollapsed: true` starts it collapsed. Declaring `queryParametersCollapsed` on an `above` or `below` strip adds the toggle there too. Collapsing only hides the controls: values, playing sliders, and everything else keep running.

The strip moves down only when its visible bounds would overlap the map's action buttons or edit button. Expanding, collapsing, and resizing recalculate that spacing; a collapsed chip keeps its usual position when it fits. Marker search and place search panels use the same behavior. The action buttons keep their position.

~~~places
mapProvider: openfreemap
height: 400px
queryParametersPosition: floating
queryParametersLayout: vertical
queryParametersCollapsed: true
query: SELECT * FROM places WHERE icon = '{parameter.icon}'
queryParameters:
  - name: icon
    type: enum
    optionsQuery: SELECT DISTINCT icon FROM places ORDER BY icon
    label: Icon
~~~

Values are type-checked and clamped before substitution. In the query, single quotes are escaped and booleans substitute as `1`/`0`. Control values persist for the session per block and reset to defaults after a reload.

Tap either a boolean toggle's label or its switch to change it. The switch shows the new value immediately while the map updates; an isochrone may take longer to appear while its request finishes. Toggles also support Enter and Space when focused.

## Custom controls

`control: custom` draws a parameter with a JavaScript snippet. `render` returns the control's HTML and is the only required part. It runs when the control first appears and again whenever the value changes, including when something else changes it (a map click, a selection action, or the play button). It only ever has to draw the value it is given:

~~~yaml
queryParameters:
  - name: rating
    type: int
    control: custom
    min: 1
    max: 5
    default: 3
    render: |
      return h.range(1, param.max + 1).map(n =>
        `<button type="button" data-places-value="${n}"
                 class="${n <= value ? 'is-on' : ''}">★</button>`
      ).join('');
~~~

`render` receives four arguments:

| Argument  | What it is                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `value`   | The parameter's current value, already coerced to its type                                                                            |
| `options` | Resolved options, whether they came from `options` or from `optionsQuery`                                                             |
| `param`   | `name`, `type`, `label`, `min`, `max`, `step`, `defaultValue`, `value`, `options`, `setValue(raw, { redraw })`, `onDispose()`         |
| `h`       | Helpers: `escape` and `html` (see Escaping), `range(from, to)` for numeric option lists, `classNames(...)` joining truthy class names |

### Setting the value

Two attributes in the returned HTML do the wiring. Most controls need no event code:

- `data-places-value="..."`: clicking the element sets the parameter to that value
- `data-places-input`: the form field's own value becomes the parameter's value as it changes (a checkbox reports checked/unchecked)

Reported values go through the parameter's normal coercion. A value that cannot represent the declared type is ignored, and numbers are clamped to `min`/`max`; a custom control cannot put a bad value into the block.

### Escaping

Always escape interpolated text. `optionsQuery` values come from the vault. Treat them as untrusted:

~~~yaml
    render: |
      return options.map(o =>
        `<button type="button" data-places-value="${h.escape(o)}">${h.escape(o)}</button>`
      ).join('');
~~~

`h.html` is a tagged template that escapes every interpolation: ``h.html`<span>${label}</span>` ``.

### mount

For behavior markup cannot express (dragging, canvas, or mounting another library), add `mount`. It runs after each render, receives the live element as `el` plus the same `value`, `options`, `param`, and `h`, and may return a cleanup function:

~~~yaml
queryParameters:
  - name: angle
    type: int
    control: custom
    min: 0
    max: 360
    default: 90
    render: |
      return `<canvas width="60" height="60"></canvas>`;
    mount: |
      const canvas = el.querySelector('canvas');
      const draw = () => { /* paint the dial for param.value */ };
      const onMove = event => param.setValue(angleFromPointer(event));
      canvas.addEventListener('pointermove', onMove);
      draw();
      return () => canvas.removeEventListener('pointermove', onMove);
~~~

`param.setValue()` re-renders by default, which replaces everything `render` produced. That is right for a click, but it would end a drag: pass `{ redraw: false }` from a handler that is mid-interaction and paint the new value in the handler:

~~~js
param.setValue(next, { redraw: false });
handle.textContent = param.value;
~~~

A value change from anywhere else (the play button, a map click, another block) still re-renders normally.

The cleanup runs before the next render and when the block is torn down. Anything left in the element is discarded on teardown either way.

### Rows, and paths as URLs

`options` is the `optionsQuery`'s first column, which is what a dropdown needs. A custom control also receives `rows`: the whole rows, in query order, so markup can use a caption or a date beside the value. `h.resource(path)` turns a path from one of those rows - in the vault or anywhere on the device - into a URL the webview can load, which is what an `<img>` needs.

Together they draw a gallery of whatever a query returns. With a map publishing its viewport (`selection.viewportParameter`), the gallery follows what is on screen:

~~~places-parameters
queryParametersPosition: below
queryParameters:
  - name: photo
    control: custom
    optionsQuery: |
      SELECT path, basename AS title FROM image_files
      WHERE latitude BETWEEN {parameter.viewSouth} AND {parameter.viewNorth}
        AND longitude BETWEEN {parameter.viewWest} AND {parameter.viewEast}
      ORDER BY captured DESC LIMIT 200
    render: |
      return rows.map(row =>
        `<img class="photo-tile" src="${h.resource(row.path)}" title="${h.escape(row.title)}" ${h.valueAttribute}="${h.escape(row.path)}">`
      ).join('');
~~~

Clicking a tile sets the parameter to that photograph's path, which the map can read back through `markerFilter` or a query of its own.

### Notes

- A script error renders in place of the control, with the parameter name; the other controls stay interactive.
- `render` is required for `control: custom`, and both keys are rejected on any other control.
- Custom controls take part in `play`: with `options` they cycle, and with a numeric `min`/`max` they step like a slider.
- `rows` is kept for custom controls only; every other control reads `options`.

## Styling

Style the controls with a CSS snippet or the block's `css:` setting. Each control carries `places-query-param` classes plus `data-param-name`, `data-param-type`, and `data-param-control` attributes:

~~~css
.places-query-param[data-param-name="limit"] .places-query-param-label {
  color: var(--text-accent);
}
~~~

## Filtering markers

`markerFilter` hides every place its condition rejects, marker and label together. The grammar is the one `iconStyles` rules use, without the `=> css` part: comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`), a bare field for a truthy check, `!` to invert, `IN` and `NOT IN` against a comma list, and `AND` or `OR` inside one rule. The right side may be a `{parameter.*}` placeholder; a multiselect substitutes the comma list `IN` expects.

~~~places
query: SELECT * FROM places
markerFilter: tag IN {parameter.show}
queryParameters:
  - name: show
    type: list
    control: multiselect
    options: [hiking, cycling, paddling]
    default: all
~~~

A YAML list of rules keeps a place that matches any one of them. Conditions that must all hold go in one rule joined with `AND`:

~~~yaml
markerFilter: icon_label IN {parameter.icon} AND distance_mi >= {parameter.distance.min} AND distance_mi <= {parameter.distance.max}
~~~

The left side is a field of the place as its data source supplies it: a query column, a frontmatter property, `tag:<name>`, or the marker's `name` and `icon`. A note without an icon draws the default marker but carries an empty `icon` field, so a filter that has to keep such notes selects on a query column instead, such as `COALESCE(NULLIF(TRIM(icon), ''), 'No icon') AS icon_label`. There is no substring operator; free-text search belongs in the query.

Filtering does not re-run the query. With native symbol markers, a parameter that reaches only `markerFilter` toggles marker and track visibility on the live map; with HTML markers and Leaflet the block re-renders with the hidden places dropped. A parameter that also reaches the query or another setting prepares the block in full. `debug: parameters` lists each rule with its match count and the field names it can see.

## Debugging parameters and filters

Add `debug: parameters` to a places block to see the machinery under the controls:

- a table of every parameter with its current value and options,
- each setting that references `{parameter.*}`, shown as written and as it ran after substitution (including the query),
- each `markerFilter` rule with how many places it matched, and the metadata field names conditions can see (field names are normalized by the data source; rules must use the spelling shown here).

The panel updates as the controls change. While any `debug:` mode is on, clicking a marker also shows a "Debug: fields & filters" section in its popup with that place's fields and each rule's verdict for it - the quickest way to answer "why is this marker hidden or shown?". Modes combine as a comma list, e.g. `debug: true, parameters`.
