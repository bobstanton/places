---
id: query-help
title: Query Help
---

# Querying places with VaultQuery

The `query` setting runs a [VaultQuery](https://community.obsidian.md/plugins/vaultquery) SQL query to find place notes and track files. Queries for note properties require VaultQuery's "Index frontmatter" setting.

~~~places
mapProvider: mapbox
height: 500px
query: SELECT * FROM places
~~~

Dataview queries are also supported with `dataview:`.

## The current note

`{this.*}` placeholders resolve against the containing note before the query runs, quoted and escaped for SQL. `{this.outgoingLinks}` formats every link the note makes (body and frontmatter) for `IN (...)`. One query maps everything the note links to:

~~~places
mapProvider: openfreemap
query: SELECT * FROM places WHERE path IN ({this.outgoingLinks}) ORDER BY title
~~~

Declaring a `query` (or any explicit source) suppresses the note's own frontmatter Location fallback. A query that excludes the current note with `WHERE path != '{this.path}'` is honored rather than having the note silently re-added.

Frontmatter values resolve the same way (`{this.Rating}`), alongside built-ins such as `{this.folder}`, `{this.tags}`, and `{this.today}`. The full placeholder list is in VaultQuery's own help.

## Views

Places creates four convenience views over VaultQuery's data:

| View          | Columns                                                                                                                                | Use Case                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| places        | path, `title`, `note_tags`, `note_modified`, `note_size`, overlay_source, overlay_cache, and all indexed scalar frontmatter properties | Markers, tracks, and data for templates and styles |
| places_simple | path, title, location, icon                                                                                                            | Fast queries for basic markers                     |
| places_tracks | Same columns as `places`                                                                                                               | Track queries with the full property set           |

| places_files | path, title, file details, content_status, content_error, overlay_source | Indexed GPX, FIT and GeoJSON files |

`places_tracks` does not filter out notes without tracks. Both full views expose `overlay_source` and `overlay_cache`, even when no note currently has those properties.

A track-only map keeps the notes that store overlay data:

~~~places
mapProvider: leaflet
query: SELECT * FROM places_tracks WHERE overlay_source IS NOT NULL
track:
  colorBy: elevation
~~~

The views join freely with VaultQuery's own tables; `places-queryparameters-help` filters on `notes.size` this way.

## Track files

`places_files` draws GPX, FIT and GeoJSON files whose contents are indexed by VaultQuery. Select those extensions in VaultQuery's **Index other file content** setting. No place note or `Location` property is required.

~~~places
query: |
  SELECT * FROM places_files
  WHERE path LIKE 'Tracks/Scranton/%'
track:
  defaultVisibility: visible
~~~

The filename supplies the title. A file's tracks, segments and waypoints belong to one place. A query can override the title and settings as it does for place notes.

When selecting individual columns, include `overlay_source`:

~~~places
query: SELECT path, title, overlay_source FROM places_files
track:
  defaultVisibility: visible
~~~

Returning only `path` does not load a path overlay. Queries use the contents indexed by VaultQuery, including when inspecting a track. In manual indexing mode, changes appear after reindexing. Unavailable or invalid contents produce a message for that file; other valid places still load. Add `WHERE content_status = 'ready'` to exclude unavailable contents.

Direct queries can return `content AS overlay_source` from `other_files`. Text and binary contents are supported without encoding them in SQL. The note views keep their existing results. To combine them explicitly:

~~~places
query: |
  SELECT path, title, location, overlay_source, overlay_cache FROM places
  UNION ALL
  SELECT path, title, NULL, overlay_source, NULL FROM places_files
  WHERE content_status = 'ready'
track:
  defaultVisibility: visible
~~~

## Photos

`image_files` holds the Exif of every image VaultQuery indexes, including its coordinates. Turn on **Index image metadata** under VaultQuery's **Other files** settings. Its `location` column is the same `latitude, longitude` text the note views return. A geotagged photo needs no note and no `Location` property.

~~~places
query: |
  SELECT path, basename AS title, location, '📷' AS icon,
         captured, camera_model, lens_model, iso,
         exposure_time_text, f_number, focal_length,
         oriented_width, oriented_height, description
  FROM image_files
  WHERE location IS NOT NULL
popup:
  content:
    - renderer: image.preview
~~~

`path` links the marker to the image. The built-in `image.preview` renderer draws the picture, then its capture time, camera and lens, and exposure, reading the `image_files` column names returned above. It reserves the photo's shape from `oriented_width` and `oriented_height` before the file decodes, and reports the formats a browser cannot decode - HEIC, TIFF, JPEG XL, and camera raw - in place of the picture. A note joined to its photo names the file in an `image_path` column. Clicking the picture opens it full screen; a right-click opens the file's own menu, carrying whatever the platform contributes - **Open in default app** and **Show in system explorer** on desktop. A photograph in one of VaultQuery's external folders is drawn from its absolute path, and its right-click menu offers the same two items plus **Copy path**, which is also how a HEIC or raw file no browser decodes still reaches a viewer.

Add `iconImage: "{this.path}"` to draw each photograph as its own marker rather than an icon glyph.

`captured` is milliseconds since the epoch; `captured_local` is the same moment as the camera wrote it. `gps_direction` is the bearing the camera faced, which `iconRotation` turns into a pointed marker.

## Column rules

- Indexed property columns are named in lowercase with underscores (`Rating` becomes `rating`, `Overlay Source` becomes `overlay_source`, and `track.colorBy` becomes `track_colorby`). Lookups are case-insensitive: `WHERE Rating > 80` resolves to `rating`. Refer to the indexed name, such as `interest_level`, rather than the original name with spaces. Explicit result aliases can contain dots and spaces; setting aliases use the dotted names described below.
- The note name is `title` in every view, matching VaultQuery's `notes` table. In `places`, a frontmatter property also named `title` does not shadow it; the property's column is `"title:1"`.
- Only single-value properties become columns. Properties stored as lists (tags, aliases, or anything set to the List type in Obsidian's property editor) are not included.
- The exception is `note_tags` in both full views: the note's frontmatter tags joined with line breaks. Match a tag with `WHERE note_tags LIKE '%restaurant%'`.

## Note properties and query overrides

Return settings as individual columns, using exactly the same names as note properties. Quote dotted aliases in SQL:

~~~places
query: |
  SELECT path, title, location, icon, overlay_source, overlay_cache,
         'none' AS "track.colorBy",
         'visible' AS "track.defaultVisibility",
         '5 solid #16a34a' AS "track.style"
  FROM places_tracks
  WHERE overlay_source IS NOT NULL OR overlay_cache IS NOT NULL
track:
  colorBy: elevation
  defaultVisibility: hidden
~~~

Precedence is **query rows > note properties > code block > global defaults**. Note properties supply values omitted by the query:

~~~yaml
track.colorBy: grade
track.defaultVisibility: hidden
~~~

There is no `places:` or `settings:` container or JSON column. Ordinary SQL expressions, including `CASE WHEN`, can compute each setting. Missing or null settings inherit. Use `track.defaultVisibility`, rather than `trackDefaultVisibility` or `defaulttrackvisibility`.

A returned `path` loads the note's presentation properties and metadata directly, including list properties, even when the query selects only `path` and `location`. This also works with `places_simple`. The query must return `location` or drawable overlay contents, and any `icon`, `overlay_source`, or `overlay_cache` it needs; those omitted data columns are not filled from the note. Rows without a note path can use the same setting columns.

For ordinary data, query values override note metadata. Presentation follows the specificity order above. Other returned columns remain data for templates and style conditions. Avoid duplicate aliases when adding setting columns to an existing projection.

Popup content also uses individual columns, such as `'knap' AS "popup.content.renderer"` and `'Templates/Popup.knap.md' AS "popup.content.options.templateFile"`. Return `'none' AS "popup.content"` to clear the body. See `places-style-help` for the complete property inventory, style rules, zoom limits, and multiple popup sections.

Renderer options use the corresponding block paths: `'captured, camera_model' AS "popup.content.options.fields"` overrides an inherited image renderer's metadata. For multiple sections, use `popup.content.0.options.fields`. `NULL` inherits; an empty string hides metadata. Renderer selection remains `popup.content.renderer`.

The pre-query `{this.*}` substitution described above also applies inside SQL strings. To return a template for each result, build its braces in SQL: `'Label: ' || char(123) || 'this.name' || char(125) AS "labelTemplate"`. Places then resolves that template against each result.

## Interactive controls

`queryParameters` adds UI controls that substitute values into the query and other block settings at render time. See `places-queryparameters-help`.
