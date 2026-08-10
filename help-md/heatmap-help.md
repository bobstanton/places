---
id: heatmap-help
title: Places Heatmap Help
---

# Places Heatmap Help

Generate heatmaps from note's overlays, render as point clouds, or opacity stacks, or compute shared corridors.

## Basic Usage

~~~places-heatmap
mapProvider: leaflet
gridSize: 100
minFrequency: 2
strategy: track-corridor
~~~

## Settings

| Setting         | Description                                                                                              | Examples                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| strategy        | Analysis algorithm                                                                                       | **track-corridor**, opacity-stacking, density-cloud        |
| dataview        | Dataview query to filter notes                                                                           | FROM "folder" WHERE "Overlay Source"                       |
| gridSize        | Spatial resolution for overlap detection. Smaller = more precision, slower. Larger = faster, less detail | **100**, 50, 200, 500                                      |
| minFrequency    | Only show segments traveled at least this many times. Higher = less noise, focus on common routes        | **2**, 1, 3, 5                                             |
| maxSegments     | Limit output to top N most-traveled segments. Use 'unlimited' for all                                    | **100**, 50, 200, unlimited                                |
| colorScheme     | Preset name OR a custom comma-separated list of hex colors interpolated low-to-high                      | **yellow-to-red**, blues, or `#ffffcc, #fd8d3c, #e31a1c`   |
| lineThickness   | Visual weight of route lines. Thicker lines are more visible but may overlap                             | **3**, 2, 5, 10                                            |
| lineStyle       | Solid or dashed pattern. Use quotes for custom: "dash,gap"                                               | **solid**, "5,10", "10,5", "2,2"                           |
| lineOpacity     | Fixed line opacity, instead of opacity stacking                                                          | 0.4, 0.8                                                   |
| minOpacity      | Baseline visibility for low-overlap areas (opacity-stacking only)                                        | **0.01**, 0.05, 0.1, 0.5                                   |
| maxOpacity      | Peak visibility where routes overlap most (opacity-stacking only)                                        | **1.0**, 0.8, 0.5                                          |
| legendLocation  | Where to display the color legend                                                                        | **hidden**, top, bottom                                    |
| infoLocation    | Where to display analysis statistics                                                                     | **hidden**, top, bottom                                    |
| poiDiscovery    | Enable clicking base-map POIs on the heatmap. Defaults off for this utility map                          | true, **false**                                            |
| autorefresh     | Re-render when the vault index changes                           | **true**, false                                                |
| queryParameters | UI controls that adjust the block without editing it. See `places-queryparameters-help`                  | `- name: limit`<br>`  type: int`<br>`  min: 1`<br>`  max: 40`                              |
| mapProvider     | Which map service renders the background tiles. Defaults to the first available provider                 | {{dynamic:mapProviderNames}}                               |
| style           | Visual theme of the base map                                                                             | satellite, streets, terrain, outdoors (varies by provider) |
| height          | Container height. Use calc() for responsive sizing                                                       | **calc(100vh - 200px)**, 400px, 50vh                       |
| width           | Container width. Usually 100% to fill available space                                                    | **100%**, 800px, 90vw, calc(100% - 50px)                   |

## Analysis Strategies

| Strategy         | Description                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| track-corridor   | Checks each track point against nearby tracks, then draws each shared corridor once at its local frequency. Linear in total points; hundreds of tracks are still practical. |
| opacity-stacking | Draws each route as a translucent line; overlapping routes accumulate opacity.                                                                                              |
| density-cloud    | Clusters points with directional distance. Places where tracks pass through the same corridor get heavier points, which suits native heatmap layers in MapLibre and Mapbox. |

## Color Schemes

### Yellow-to-Red (default)

Light yellow, yellow, orange, red, dark red.

### Blues

Light blue, medium blue, dark blue, navy.

### Custom Colors

Provide a comma-separated list of hex colors. They become the gradient stops from lowest to highest frequency, and the plugin interpolates between them. `#rgb` and `#rrggbb` are both accepted.

~~~places-heatmap
strategy: track-corridor
colorScheme: #ffffcc, #41b6c4, #225ea8, #081d58
minFrequency: 2
legendLocation: bottom
~~~

A two-color list gives a simple low-to-high fade:

~~~places-heatmap
strategy: track-corridor
colorScheme: #e0e0e0, #d7191c
~~~

Each strategy applies custom colors differently: `track-corridor` colors each segment by frequency, `density-cloud` builds the heatmap gradient from the given stops (the lowest stop fades to transparent), and `opacity-stacking` uses the last (highest) color as its base with overlap shown by opacity.

## Examples

### Common Routes

~~~places-heatmap
strategy: track-corridor
colorScheme: yellow-to-red
minFrequency: 3
legendLocation: bottom
~~~

### Filter by Folder

~~~places-heatmap
dataview: FROM "Scranton"
  WHERE "Overlay Source"
strategy: track-corridor
legendLocation: bottom
infoLocation: bottom
~~~

### Density Cloud 

~~~places-heatmap
strategy: density-cloud
gridSize: 100
colorScheme: blues
~~~

### Opacity Stacking

~~~places-heatmap
strategy: opacity-stacking
maxSegments: 200
minOpacity: 0.01
maxOpacity: 1.0
~~~

