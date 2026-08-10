---
id: query-help
title: Query Help
---

# Querying places with VaultQuery

The `query` setting runs a [VaultQuery](https://community.obsidian.md/plugins/vaultquery) SQL query to find notes with locations. VaultQuery's "Index frontmatter" setting must be enabled; with it off, query blocks show an error explaining what to enable.

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

Places creates three convenience views over VaultQuery's data:

| View          | Columns                                                    | Use Case                              |
| ------------- | ---------------------------------------------------------- | ------------------------------------- |
| places        | path, `title`, `note_tags`, `note_modified`, `note_size`, plus every frontmatter property as a column | Full metadata for CSS data attributes |
| places_simple | path, title, location, icon                                | Fast queries for basic markers        |
| places_tracks | path, title, location, icon, overlay_source, overlay_cache | Tracks with elevation data            |

A track-only map keeps the notes that store overlay data:

~~~places
mapProvider: leaflet
query: SELECT * FROM places_tracks WHERE overlay_source IS NOT NULL
track:
  colorBy: elevation
~~~

The views join freely with VaultQuery's own tables; `places-queryparameters-help` filters on `notes.size` this way.

## Column rules

- Property columns are named in lowercase with underscores (`Rating` becomes `rating`, `Overlay Source` becomes `overlay_source`). Lookups are case-insensitive: `WHERE Rating > 80` resolves to the `rating` column, but quoted names must not contain spaces. `"Interest Level"` matches nothing and SQLite silently treats it as a text literal; use `interest_level` instead.
- The note name is `title` in every view, matching VaultQuery's `notes` table. In `places`, a frontmatter property also named `title` does not shadow it; the property's column is `"title:1"`.
- Only single-value properties become columns. Properties stored as lists (tags, aliases, or anything set to the List type in Obsidian's property editor) are not included.
- The exception is `note_tags` in the `places` view: the note's frontmatter tags joined with line breaks. Match a tag with `WHERE note_tags LIKE '%restaurant%'`.

## Interactive controls

`queryParameters` adds UI controls that substitute values into the query and other block settings at render time. See `places-queryparameters-help`.
