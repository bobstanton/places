---
id: image-align-help
title: Image Overlay Alignment Tool
---

# Image Overlay Alignment Tool

Position and align an image over a map. Drag the image to move it, Shift-drag to scale, Alt-drag to rotate, and drag the corner markers to skew.

## Basic Usage

~~~places-image-align
mapProvider: mapbox
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
height: 600px
~~~

The current alignment is retained in memory for the session. When the note re-renders or is reopened, the tool restores the four image corners for that code block and image. This working state is not written to the note and is cleared when the app session ends.

## Settings

| Setting       | Description                                                             | Examples                                                      |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| mapProvider   | Map provider to use (optional; defaults to the configured map provider) | {{dynamic:imageAlignmentProviderNames}}                       |
| overlays      | Image path, optionally with initial coordinates                         | Expanded list with `path` plus optional `bounds` or `corners` |
| height        | Map height                                                              | 500px (default), 600px, calc(100vh - 200px)                   |
| style         | Map style (varies by provider)                                          | streets, satellite, outdoors, etc.                            |
| opacity       | Image overlay opacity                                                   | 0.0 to 1.0 (default: 1.0)                                     |
| initialZoom   | Initial map zoom level                                                  | 1-20 (auto-fits to image by default)                          |
| initialCenter | Initial map center                                                      | lat,lng (auto-centers on image by default)                    |

## Coordinate Formats

### Bounds Format (4 coordinates)

Axis-aligned rectangle: swLat,swLng,neLat,neLng

~~~places-image-align
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    bounds: 41.40,-75.67,41.42,-75.65
~~~

### Corners Format (8 coordinates)

Rotated/skewed image: nwLat,nwLng,neLat,neLng,seLat,seLng,swLat,swLng

~~~places-image-align
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    corners: 41.42,-75.67,41.42,-75.65,41.40,-75.65,41.40,-75.67
~~~

## Corner Markers

Drag the colored corner markers to reposition the image:

- Red - Northwest corner
- Green - Northeast corner
- Blue - Southeast corner
- Yellow - Southwest corner

## Controls

| Action                 | Control                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Move entire image      | Drag on the image                                                  |
| Scale image            | Shift + drag (image or a corner marker), or mouse wheel over image |
| Rotate image           | Alt + drag (image or a corner marker)                              |
| Skew / move one corner | Drag a colored corner marker                                       |
| Fine-tune position     | Arrow keys (~1m steps)                                             |
| Larger position steps  | Shift + Arrow keys (~10m steps)                                    |
| Pan the map            | Drag outside the image                                             |
| Copy coordinates       | Click clipboard button                                             |

## Output

The tool displays real-time coordinates during adjustment. Copy the output directly into places code blocks:

~~~places
mapProvider: mapbox
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    bounds: 41.25,-75.75,41.5,-75.5
height: 500px
~~~

If the image is axis-aligned (not rotated), the tool shows both the 8-coordinate (corners) format and the 4-coordinate (bounds) format.

## Related Documentation

- `places-overlay-help` - Image overlay display options
