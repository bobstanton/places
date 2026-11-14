---
id: directions-help
title: Directions Help
---

# Directions

`directions` generates routed paths as GeoJSON overlays, using an installed route provider plugin. Waypoints come from note links, coordinates, or a VaultQuery.

{{dynamic:routeProviders}}

By default the map provider's own route service is used when it has one, otherwise the first available route service. To pick a service explicitly, set `routeProvider` at the block level, or `provider` inside an individual group.

## Basic usage

`directions` is a list of group mappings. Each entry under `routes` holds either a `waypoints` list or a `query`, not both. A waypoint can be a wiki link, note path, raw `lat, lng` coordinate, named coordinate in the form `Name: lat, lng`, or `{this}` for the current note. Named coordinates use the name in endpoint and leg labels. A list item that is exactly one `{parameter.*}` placeholder expands to one waypoint per entry of the referenced `list` parameter. A `stops` control edits the route interactively. See `places-queryparameters-help`.

~~~places
mapProvider: stadia
height: 500px
directions:
  - mode: drive
    optimize: false
    style:
      color: "#2563eb"
      strokeOpacity: 0.85
      strokeWidth: 5
    labelTemplate: "{this.distance_text} · {this.duration_text}"
    routes:
      - waypoints:
          - "[[Dunder Mifflin Scranton]]"
          - "[[Poor Richards]]"
          - "[[Alfredos Pizza Cafe]]"
      - waypoints:
          - "{this}"
          - "Downtown Scranton: 41.4084, -75.6624"
          - "[[Coopers Seafood House]]"
~~~

Multiple groups can be listed when each needs its own mode, style, routes, or optional `name`:

~~~places
mapProvider: mapbox
height: 500px
directions:
  - name: bike route
    mode: bike
    style:
      color: "#2563eb"
    routes:
      - waypoints:
          - "[[Dunder Mifflin Scranton]]"
          - "[[Lake Scranton]]"
  - name: walking route
    mode: walk
    style:
      color: "#16a34a"
    routes:
      - waypoints:
          - "[[Dunder Mifflin Scranton]]"
          - "[[Alfredos Pizza Cafe]]"
~~~

## Route queries

Route entries can also be VaultQuery SQL queries. The query must return the same required columns as a map query (`path` and `Location`) and the returned row order is used as the waypoint order. Add `ORDER BY` when order matters.

~~~places
mapProvider: stadia
directions:
  - mode: drive
    routes:
      - query: "SELECT * FROM places WHERE path IN ({this.outgoingLinks}) ORDER BY title"
~~~

## Modes and options

Modes are `drive`, `walk`, and `bike`. `optimize: true` asks supported providers to keep the first and last waypoint fixed while reordering intermediate stops for a shorter or faster route; it defaults to `false`.

Style the generated line with `color`, `strokeOpacity`, and `strokeWidth`. Quote hexadecimal colors. When the provider returns distance or duration, those values are stored on the generated GeoJSON features along with simplestyle line properties.

Add `traffic: true` to a driving group to route around typical traffic. Mapbox honors it through `driving-traffic` and Geoapify approximates it; every other route provider ignores it and returns free-flow routes. Traffic only applies to `mode: drive`, and traffic requests always fetch fresh data instead of using the overlay cache.

## Labels

Route labels are on by default; the default text is distance plus time. Override the total-route text globally in settings, per block with `routeLabelTemplate`, or inside a group with `labelTemplate`. The template resolves against the whole route, for example `labelTemplate: {this.end_name} · {this.distance_text}`:

| Placeholder                                         | Description                                      |
| --------------------------------------------------- | ------------------------------------------------ |
| `{this.start_name}`, `{this.end_name}`              | First and last waypoint names                    |
| `{this.distance_text}`, `{this.duration_text}`      | Formatted totals, such as `12.4 mi` and `25 min` |
| `{this.distance_meters}`, `{this.duration_seconds}` | Numeric totals                                   |
| `{this.mode}`                                       | `drive`, `walk`, or `bike`                       |
| `{this.name}`                                       | The group `name` with the route number appended  |
| `{this.waypoints}`                                  | Every waypoint name, in visit order              |

`metricLabels: legs` shows distance and time between each stop. `metricLabels: both` shows the total plus each leg. `metricLabels: none` hides generated metric labels. Customize per-leg labels with `legLabelTemplate`, resolved against each leg:

| Placeholder                                         | Description                            |
| --------------------------------------------------- | -------------------------------------- |
| `{this.from_name}`, `{this.to_name}`                | The leg's start and end waypoint names |
| `{this.distance_text}`, `{this.duration_text}`      | Formatted leg metrics                  |
| `{this.distance_meters}`, `{this.duration_seconds}` | Numeric leg metrics                    |
| `{this.index}`                                      | Leg position, starting at 0            |

Each waypoint marker is labeled too: `Start:`, `Stop 2:`, and `End:` by default. Customize them with `waypointLabelTemplate`, set globally in settings, per block, or inside a group. It resolves against each waypoint:

| Placeholder         | Description                                    |
| ------------------- | ---------------------------------------------- |
| `{this.name}`       | Waypoint name                                  |
| `{this.role}`       | `start`, `stop`, or `end`                      |
| `{this.role_label}` | `Start`, `Stop 2`, `End`                       |
| `{this.index}`      | Position in the route, starting at 0           |
| `{this.icon}`       | The linked note's icon; empty for a coordinate |
| `{this.path}`       | The linked note's path; empty for a coordinate |

For example, `waypointLabelTemplate: {this.name}` drops the role prefixes, and an explicitly empty value hides the waypoint labels while keeping the markers. The same key labels GPX `<wpt>` markers on overlays. One global template styles both.
