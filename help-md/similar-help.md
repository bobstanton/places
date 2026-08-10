---
id: similar-help
title: Places Similar Tracks Help
---

# Places Similar Tracks Help

Find tracks in the vault that are similar to the current note's track or tracks near a specific location.

## Basic Usage

~~~places-similar
maxResults: 5
minSimilarity: 70
~~~

## Settings

| Setting          | Description                                                                                  | Examples                                      |
| ---------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| minSimilarity    | Frechet similarity threshold (0-100). Measures how identical the track shapes are end-to-end | **70** (or 0.7), 50, 85, 90                   |
| minOverlap       | Overlap percentage threshold (0-100). Measures what % of the track shares the same route     | 50, 70, 85                                    |
| tolerance        | Max deviation in degrees for Frechet calculation. Higher = more lenient                      | **0.01** (~1.1km), 0.05 (~5.5km), 0.1 (~11km) |
| overlapTolerance | Distance in meters for overlap calculation. How close points must be to count as overlapping | **50**, 25, 100                               |
| maxResults       | Cap results to this many tracks                                                              | **unlimited**, 5, 10, 20                      |
| radius           | Search radius for point-based search. Uses configured units (miles/km)                       | **note's Distance** or **1.0**, 2, 5, 10      |
| location         | Center point for point-based search                                                          | **note's Location**, 41.408,-75.662           |
| showPersonalBest | Highlight the fastest completion with a trophy icon                                          | **false**, true                               |
| showSpeedTime    | Add columns showing average speed and total duration                                         | **false**, true                               |
| autorefresh      | Re-render when the vault index changes               | **true**, false                                   |
| queryParameters  | UI controls that adjust the block without editing it. See `places-queryparameters-help`      | `- name: limit`<br>`  type: int`<br>`  min: 1`<br>`  max: 40`                 |

## Matching Method

### Two Search Modes:

- Track Similarity: If the current note has track data in Overlay Source or Overlay Cache, finds similar routes
- Point-Based: If no track data or location specified, finds tracks near a location

### Track Similarity Calculation:

Uses discrete Frechet distance to measure how well two tracks align:
- Checks both forward and reverse directions
- The `tolerance` setting controls how far apart tracks can deviate and still be considered similar
- Total distance comparison (tracks must be within 20% length similarity)
- Geographic bounding box overlap (tracks must be in similar areas)

**Understanding Tolerance:** The Frechet distance measures the maximum deviation between two tracks at their furthest-apart point. With default tolerance (0.01 degrees = ~1.1km), tracks that share a starting section but diverge later will score 0% similarity because their divergent sections exceed the tolerance. Increase tolerance for routes that share portions but go different places.

Units: The radius setting uses the configured units (miles if imperial, km if metric).

If no radius is specified, it defaults to the current note's Distance frontmatter value.

Minimum Requirements: Tracks must have at least 2 GPS points. Similarity accepts percentages (70) or decimals (0.7).

## Examples

### Find Very Similar Tracks

~~~places-similar
maxResults: 3
minSimilarity: 85
~~~

### Find Tracks Near a Location

~~~places-similar
location: "Downtown Scranton: 41.408, -75.662"
radius: 5
maxResults: 10
~~~

Location values accept either `latitude, longitude` or `Name: latitude, longitude`.

### Show Performance Metrics

~~~places-similar
showSpeedTime: true
showPersonalBest: true
minSimilarity: 50
~~~

### Find Tracks That Share a Common Section

For tracks that start the same but go to different destinations, increase tolerance:

~~~places-similar
minSimilarity: 10
tolerance: 0.1
~~~

When there are no results where some are expected, lower the minSimilarity threshold or increase tolerance.
