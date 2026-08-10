---
id: chart-help
title: Places Chart Help
---

# Places Chart Help

Render a track as a chart based on its elevation, speed or pace as a function of distance or time.

## Basic Usage

~~~places-chart
chartType: elevation
height: calc(100vh - 200px)
fillArea: true
colorBy: grade
~~~

## Chart Settings

| Setting         | Description                                                                             | Examples                                                                                  |
| --------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| chartType       | What data to visualize on the Y-axis vs distance or time                                | **elevation**, elevation-grade, elevation-time, speed, speed-time, pace, pace-time, grade |
| height          | Chart container height                                                                  | **30vh**, 400px, 50vh, 600px, calc(100vh - 200px)                                         |
| width           | Chart container width                                                                   | **100%**, 800px, 90vw, calc(100% - 50px)                                                  |
| title           | Text displayed above the chart. Omit for no title                                       | "Elevation Profile", "Hike"                                                               |
| fillArea        | Shade the area under the line for visual emphasis                                       | **true**, false                                                                           |
| colorBy         | Color the chart fill by data                                                            | **none**, elevation, grade                                                                |
| gradeWindow     | Span the rolling grade is measured over. Larger = smoother, less noise                  | **100ft**, 50m, 0.1mi, 10min                                                              |
| speedWindow     | Span speed and pace are averaged over. A time window reads better across stops           | **200m**, 500ft, 0.25mi, 30s, 5min                                                        |
| showGrid        | Display horizontal/vertical reference lines                                             | **true**, false                                                                           |
| stats           | Which summary statistics to show below the chart                                        | elevation, time, speed, pace, distance, points                                            |
| showPoints      | Mark each data point on the line                                                        | **false**, true                                                                           |
| smoothing       | Smooth the line between points                                                          | **true**, false                                                                           |
| legend          | Show the color legend for `colorBy` shading                                             | **hidden**, top, bottom                                                                   |
| position        | Coordinate to highlight on a single-track chart                                         | {parameter.selectedPoint}                                                                 |
| selection       | Typed selection channel shared with maps and other charts                               | channel: primary                                                                          |
| axisColor       | Axis line color                                                                         | **#666**, #000                                                                            |
| elevationColor  | Elevation line color                                                                    | **#2196F3**                                                                               |
| speedColor      | Speed line color                                                                        | **#ff7f00**                                                                               |
| paceColor       | Pace line color                                                                         | **#dc3545**                                                                               |
| gradeColor      | Grade line color                                                                        | **#ff7f00**                                                                               |
| fontSize        | Label font size in pixels                                                               | **12**, 10, 14, 16                                                                        |
| autorefresh     | Re-render when the vault index changes          | **true**, false                                                                               |
| queryParameters | UI controls that adjust the block without editing it. See `places-queryparameters-help` | `- name: limit`<br>`  type: int`<br>`  min: 1`<br>`  max: 40`                                                             |


## Available Chart Types

| Chart Type      | Description                                   |
| --------------- | --------------------------------------------- |
| elevation       | Elevation profile over distance               |
| elevation-grade | Combined elevation profile with grade overlay |
| elevation-time  | Elevation change over time                    |
| speed           | Speed variations over distance                |
| speed-time      | Speed variations over time                    |
| pace            | Pace (min/km or min/mi) over distance         |
| pace-time       | Pace variations over time                     |
| grade           | Grade/slope percentage over distance          |


## Fill Coloring Systems

Use `colorBy` to color the chart fill based on data:

### Grade Coloring (`colorBy: grade`)

9-color system based on grade percentage calculated over a configurable distance (default 100):

- <= -25%: Very dark navy - Extreme descents
- -25% to -16%: Dark blue - Very steep descents
- -16% to -10%: Medium blue - Steep descents
- -10% to -3%: Light blue - Moderate descents
- -3% to +3%: Gray - Flat terrain
- +3% to +10%: Light orange - Moderate climbs
- +10% to +16%: Orange - Steep climbs
- +16% to +25%: Red-orange - Very steep climbs
- >= +25%: Dark red - Extreme climbs

~~~places-chart
chartType: elevation
fillArea: true
colorBy: grade
gradeWindow: 100ft
height: 350px
~~~

### Elevation Coloring (`colorBy: elevation`)

Smooth gradient from blue (valleys) through green (lowlands) and brown (mountains) to white (peaks).

## Available Statistics

- distance - Total distance covered
- elevation - Gain, loss, min, max, net elevation
- time - Start time, end time, duration
- speed - Average and max speed
- pace - Average and best pace
- points - Number of data points

Use comma-separated values in the stats setting: `stats: elevation,time,speed`

## Dual Track Charts

Chart two tracks on a single chart using `track1` and `track2`:

~~~places-chart
track1: [[Morning Run - Monday]]
track2: [[Morning Run - Tuesday]]
height: 400px
fillArea: true
stats: distance,elevation,time
~~~

| Setting | Description                                         | Examples                    |
| ------- | --------------------------------------------------- | --------------------------- |
| track1  | Path to first track note (wiki-link or quoted path) | `[[Morning Run - Monday]]`  |
| track2  | Path to second track note                           | `[[Morning Run - Tuesday]]` |

Both elevation profiles are overlaid on the same chart with a statistics table showing the differences.

### Series Names

Chart legend names are determined by:
1. **GPX track name** from the original file's metadata (if available)
2. **Filename** of the note as fallback

