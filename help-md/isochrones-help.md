---
id: isochrones-help
title: Isochrones Help
---

# Isochrones

Generate an overlay indicating the reachable areas around one or more centers.

{{dynamic:routeProviders}}

## Basic Usage

~~~places
mapProvider: leaflet
routeProvider: openrouteservice
isochrones:
  - mode: walk
    ranges:
      - 10 min
      - 20 min
    centers:
      - "{this}"
  - name: stadia comparison
    provider: stadia
    mode: walk
    ranges:
      - 10 min
      - 20 min
    centers:
      - "{this}"
~~~

`ranges` is a YAML list where every value has a time or distance unit. Supported examples include `30 min`, `2 hr`, `500 m`, `5 km`, `3 mile`, and `1000 ft`. Time and distance values may be mixed in the same group. Centers are a list of note links, `{this}`, wikilinks or coordinates. A list item that is exactly one `{parameter.*}` placeholder expands to one center per entry of the referenced `list` parameter. See `places-queryparameters-help`.

Add `minZoom` and `maxZoom` inside a group to show that generated overlay only at specific map zoom levels. 

~~~places
mapProvider: mapbox
height: 500px
isochrones:
  - mode: walk
    ranges:
      - 10 min
      - 20 min
      - 30 min
    minZoom: 8
    maxZoom: 13
    centers:
      - "{this}"
      - "[[Steamtown Mall]]"
      - "Downtown Scranton: 41.4084, -75.6624"
    polygons: true
    style:
      colors:
        - "#4f46e5"
        - "#0891b2"
        - "#16a34a"
      fillOpacity: 0.14
      strokeOpacity: 0.85
      strokeWidth: 2
~~~

Multiple groups can be listed when each needs its own mode, centers, ranges, colors, or optional `name`:

~~~places
mapProvider: mapbox
height: 500px
isochrones:
  - name: walking reach
    mode: walk
    ranges:
      - 10 min
      - 20 min
    centers:
      - "[[Schrute Farms]]"
    style:
      colors:
        - "#16a34a"
        - "#65a30d"
  - name: biking reach
    mode: bike
    ranges:
      - 10 min
      - 20 min
    centers:
      - "[[Schrute Farms]]"
    style:
      colors:
        - "#2563eb"
        - "#0891b2"
~~~

Distance ranges specify their unit directly:

~~~places
mapProvider: stadia
isochrones:
  - mode: bike
    ranges:
      - 500 m
      - 1 km
      - 2 mile
    centers:
      - "[[Schrute Farms]]"
~~~

## Traffic-aware driving isochrones

By default isochrones use free-flow road speeds. Add `traffic: true` to a driving group to fold typical traffic conditions into the reachable area. 

~~~places
mapProvider: mapbox
height: 500px
isochrones:
  - mode: drive
    traffic: true
    ranges:
      - 15 min
      - 30 min
    centers:
      - "[[Dunder Mifflin Scranton]]"
~~~

Traffic support is provider-specific. Mapbox uses its `driving-traffic` profile and Geoapify approximates traffic; every other route provider ignores it and returns free-flow contours. Walking and cycling ignore the setting. `traffic: true` always fetches fresh data instead of using the overlay cache.

## Styling

`colors` is a YAML list of quoted contour colors; the list repeats when there are more contours than colors. Tune polygons with `fillOpacity`, `strokeOpacity`, and `strokeWidth`; opacity accepts decimals such as `0.14` or percentages such as `14%`. Generated features use these simplestyle properties:

| Setting         | GeoJSON property | Description                          |
| --------------- | ---------------- | ------------------------------------ |
| `colors`        | `stroke`, `fill` | Contour line and polygon fill colors |
| `strokeWidth`   | `stroke-width`   | Line width in pixels                 |
| `strokeOpacity` | `stroke-opacity` | Line opacity from 0 to 1             |
| `fillOpacity`   | `fill-opacity`   | Polygon fill opacity from 0 to 1     |


