---
id: compare-help
title: Places Compare Tracks Help
---

# Places Compare Tracks Help

Find overlap between two tracks.

## Basic Usage

~~~places-compare
track1: [[Lake Scranton Weekend Run]]
track2: [[Fun Run Training Route]]
~~~

## Settings

| Setting         | Description                                                                                                                                                                            | Examples                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| track1          | Wiki-link to first track file (required)                                                                                                                                               | `[[Lake Scranton Weekend Run]]`                               |
| track2          | Wiki-link to second track file (required)                                                                                                                                              | `[[Lake Scranton Weekend Run]]`                               |
| tolerance       | Maximum distance to consider points as matching. Uses configured units (meters/feet)                                                                                                   | **50**, 25, 100, 200                                          |
| height          | Height of the mini-map                                                                                                                                                                 | **300px**, 400px, 500px                                       |
| width           | Width of everything the block renders, its legend and info included. A percentage measures the note's width, vw the window's                                                           | **100%**, 50%, 800px                                          |
| mapProvider     | Which map provider to use                                                                                                                                                              | **default**, {{dynamic:mapProviderNames}}                     |
| showMiniMap     | Show the comparison map                                                                                                                                                                | **true**, false                                               |
| showMetrics     | Show the metrics tables                                                                                                                                                                | **true**, false                                               |
| poiDiscovery    | Enable clicking base-map POIs on the mini-map. Defaults off for this utility map                                                                                                       | true, **false**                                               |
| autorefresh     | Re-render when the vault index changes                                                                                                                                                 | **true**, false                                               |
| queryParameters | UI controls that adjust the block without editing it; `queryParametersPosition`, `queryParametersLayout`, and `queryParametersCollapsed` place them. See `places-queryparameters-help` | `- name: limit`<br>`  type: int`<br>`  min: 1`<br>`  max: 40` |
| style           | Map style (provider-specific)                                                                                                                                                          | varies by provider                                            |

## Output Sections

### Relationship Badge

The header shows a badge indicating the overall relationship:

- **No Overlap** - Tracks don't share any common route
- **Partial Overlap** - Tracks share some sections but diverge elsewhere
- **Continuation** - Tracks appear to continue one another (end-to-start connection)
- **Subset** - One track is mostly contained within the other
- **Nearly Identical** - Tracks follow almost the same route (>90% overlap)

### Mini-Map

Both tracks displayed together:
- 🔵 **Blue** - Track 1
- 🟠 **Orange** - Track 2

### Overlap Analysis

- **Track A within tolerance** - What percentage of Track A's route is within the tolerance distance of Track B
- **Track B within tolerance** - What percentage of Track B's route is within the tolerance distance of Track A
- **Shared distance** - The approximate distance where both tracks run together
- **Direction** - Whether tracks run the same direction, opposite directions, or mixed

### Track Comparison

Shows distance and elevation (if available) for both tracks in a comparison table:
- Distance for each track and the difference
- Elevation gain for each track and the difference
- Elevation loss for each track and the difference

### Key Points

Shows locations where tracks diverge or converge:
- ↗️ **Divergence** - Where tracks split apart
- ↘️ **Convergence** - Where tracks come back together
- 🔗 **Continuation gap** - The gap distance if tracks are continuations

## Comparison Method

### Tolerance Setting

The `tolerance` parameter controls how close points need to be to count as "matching":
- Lower values (25m) - Tracks must be very close to match
- Higher values (100m+) - Allows for parallel routes or slight variations

### Overlap Calculation

1. Walk Track A point by point.
2. For each point, find the closest point on Track B.
3. If that point is within `tolerance`, count the local segment as overlapping.
4. Turn the matched length into a percentage of Track A.
5. Run the same pass in reverse. The two percentages can differ, especially when one track is a short section of the other.

### Direction Detection

Compares the bearing (compass direction) of matched segments:
- Most matched segments point the same way: "Same direction"
- Most matched segments point opposite ways: "Opposite directions"
- Significant variation: "Mixed directions"

## Examples

### Compare Two Hikes

~~~places-compare
track1: [[Morning Run - Monday]]
track2: [[Morning Run - Tuesday]]
tolerance: 30
~~~

### Compare with Larger Tolerance

Parallel trails need slack:

~~~places-compare
track1: [[Poor Richards Run]]
track2: [[Steamtown Evening Run]]
tolerance: 100
height: 500px
~~~

### Compare Without Map

Metrics only:

~~~places-compare
track1: [[Morning Run - Wednesday]]
track2: [[Morning Run - Thursday]]
showMiniMap: false
~~~
