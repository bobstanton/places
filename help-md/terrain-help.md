---
id: terrain-help
title: 3D Terrain & Relief Help
---

# 3D terrain & relief

Render maps with 3D elevation, shaded relief (hillshade), and color relief (elevation tint). 

{{dynamic:terrainProviders}}

## Basic Usage

~~~places
mapProvider: mapbox
terrain:
  provider: mapbox
  exaggeration: 2
  hillshade:
    intensity: 0.8
    method: igor
    direction: 315
  colorRelief:
    opacity: 0.4
~~~

| Setting      | Description                                                                                | Examples                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| provider     | DEM source. Enables 3D terrain and turns pitch, hillshade and color relief on.      | {{dynamic:terrainProviderNames}}, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| reliefProvider | DEM for the hillshade and color-relief layers only. The map stays flat, and pitch stays off. | {{dynamic:terrainProviderNames}}, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| exaggeration | Vertical exaggeration of the 3D surface. A constant factor, or a zoom curve of `@z` stops. | **1.4**, 2, `1 @z6, 2.5 @z13`                                                                               |
| hillshade    | Shaded-relief layer, a nested block of the settings below                                  | `intensity: 0.8`<br>`method: igor`                                                                          |
| colorRelief  | Elevation-tint layer, a nested block of the settings below                                 | `opacity: 0.4`                                                                                              |

### hillshade settings

| Setting        | Description                                                                  | Examples                                              |
| -------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| intensity      | Shaded-relief strength, 0-1. Defaults to 0.5 when terrain is on; 0 disables. | 0.5, 0, 0.8                                           |
| method         | Shading algorithm.                                                           | **standard**, basic, combined, igor, multidirectional |
| direction      | Light-source direction, degrees (0-359).                                     | 335, 90                                               |
| shadowColor    | Color for shadowed slopes.                                                   | `#223344`                                             |
| highlightColor | Color for lit slopes.                                                        | `#fff8e0`                                             |
| accentColor    | Color for steep accents.                                                     | `#554433`                                             |

### colorRelief settings

| Setting | Description                                                                                            | Examples                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| opacity | Elevation-tint opacity, 0-1. Defaults to 0.4 when terrain is on; 0 disables.                           | 0.4, 0, 0.7                                                                 |
| colors  | Elevation-to-color ramp: a preset name or a custom stop list. Unset uses the default hypsometric tint. | hypsometric, viridis, spectral, grayscale, or a list of `<metres>: <color>` |

## Relief without the 3D surface

Hillshade and color relief are layers, not the 3D mesh: they render on a flat 2D map. To use them without 3D terrain, give the relief settings directly; the elevation then comes from the map provider's own DEM, for map providers that publish one. Set `intensity` or `opacity` to `0` to turn a layer off.

~~~places
mapProvider: maptiler
terrain:
  hillshade:
    intensity: 0.8
  colorRelief:
    opacity: 0
~~~

On a map provider that publishes no DEM, `reliefProvider` names one for the relief layers alone. It accepts the same values as `provider` and leaves the map flat:

~~~places
mapProvider: openfreemap
terrain:
  reliefProvider: aws
  hillshade:
    intensity: 0.8
~~~

Setting it alongside `provider` draws the 3D surface from one DEM and the relief layers from another.

Color relief draws below hillshade: shaded slopes read over the elevation tint. Both layers sit beneath roads and labels.

## Elevation color ramp

`colorRelief.colors` sets the tint by elevation. Use a named preset: **hypsometric** (default green to brown to snow), **viridis**, **spectral**, or **grayscale**:

~~~places
mapProvider: mapbox
terrain:
  provider: mapbox
  colorRelief:
    colors: viridis
~~~

Custom stops (metres to color) are interpolated between:

~~~places
mapProvider: mapbox
terrain:
  provider: mapbox
  colorRelief:
    colors:
      - 0: "#2b83ba"
      - 1000: "#ffffbf"
      - 3000: "#d7191c"
~~~
