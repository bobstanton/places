---
id: image-align-help
title: Image Overlay Alignment Tool
---

# Image Overlay Alignment Tool

## Settings

| Setting       | Description                                                  | Examples                                |
| ------------- | ------------------------------------------------------------ | --------------------------------------- |
| mapProvider   | Defaults to the configured provider                          | {{dynamic:imageAlignmentProviderNames}} |
| overlays      | One image and optional reference tracks, in any order        | See below                               |
| height        |                                                              | **500px**, 600px, calc(100vh - 200px)   |
| width         | Includes controls and output. Percentages use the note width | **100%**, 800px, 90vw                   |
| style         | Provider-specific base map style                             | streets, satellite, outdoors            |
| initialZoom   | Defaults to fitting the image                                | 1-20                                    |
| initialCenter | Defaults to the image center                                 | 41.408,-75.662                          |

~~~places-image-align
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    bounds: 41.40,-75.67,41.42,-75.65
    opacity: 0.4
  - path: Morning Run - Monday.md
height: 600px
~~~

Image `opacity` accepts an unquoted number from 0 to 1 (default: 1). 

Reference tracks accept GPX, FIT, CSV, GeoJSON, and note paths through the regular overlay loader. Notes resolve `Overlay Source` or `Overlay Cache`, including compressed data. References support overlay styling and labels; References remain beneath the image regardless of list order. 

## Adjust image

| Action                | Control                                                    |
| --------------------- | ---------------------------------------------------------- |
| Move image            | Drag the image                                             |
| Scale image           | Shift-drag the image or a corner; mouse wheel on the image |
| Rotate image          | Alt-drag the image or a corner                             |
| Skew image            | Drag a corner                                              |
| Fine-tune position    | Arrow keys                                                 |
| Larger position steps | Shift + Arrow keys                                         |
| Pan map               | Drag outside the image                                     |

Corner colors: northwest red, northeast green, southeast blue, southwest yellow.

**Reset shape** restores the image proportions without rotation or skew, preserving the center and approximate width. **Reset alignment** restores the starting coordinates, or the initial centered placement when coordinates are omitted. Both preserve point pairs.

## Match points

The image opens beside the map; narrow layouts stack the panes.

1. Choose **Add point pair**. Select corresponding locations in the image and map, in either order.
2. Repeat across the image. Drag markers to correct locations. Pairs can be selected, disabled, or deleted. Delete a pending pair or press Escape to cancel it.
3. Select a fitting method and choose **Fit image**.

| Fitting method                      | Minimum enabled pairs | Result                        |
| ----------------------------------- | --------------------- | ----------------------------- |
| Preserve proportions (`similarity`) | 2 distinct pairs      | Move, rotate, uniformly scale |
| Allow stretching/skew (`affine`)    | 3 non-collinear pairs | Also stretch and skew         |

All enabled pairs contribute to the fit. Duplicate locations, collinear image points for affine fitting, and collapsed or mirrored results prevent fitting. Image replacement with different dimensions requires new pairs. Disabled **Fit image** shows the reason on hover.

Mismatch uses the Places unit setting: feet for imperial, meters for metric. **Fit up to date** means the current pairs were used, not that the entire image aligns. Three affine pairs can have zero mismatch while compressing the image severely when the map points nearly form a line. Pairs spread across both panes constrain the image width and height.

Dragging pans each pane; the wheel zooms it. Image zoom and **View whole image** controls are inside the image pane. **View track** is inside the map. **Show overlay** controls image visibility. **Snap to track** snaps map points within 12 screen pixels of a track segment and previews the snapped position. Track popups are suspended in this mode.

Point pairs retain image pixels and map coordinates through manual adjustments. **Manually adjusted** marks manual placement; **Fit outdated** marks changed pairs or fitting settings. Fitting again replaces manual placement. **Undo** and **Redo** restore point edits, fits, adjustments, and resets; each drag is one action.

## Saving

The floating clipboard icon copies the complete alignment YAML: corners, pairs, fitting settings, opacity, references, and other block settings. Paste it into the block to save. The tool does not edit the note.

~~~places-image-align
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    opacity: 0.4
    alignment:
      fit: similarity
      points:
        - pixel: [320, 180]
          latlng: [41.419, -75.668]
        - pixel: [1450, 920]
          latlng: [41.407, -75.653]
  - path: Morning Run - Monday.md
~~~

- `pixel`: numeric `[x, y]` from the image's top-left edge; x increases rightwards, y downwards.
- `latlng`: numeric `[latitude, longitude]` within the Mercator map.
- `enabled: false`: excludes a pair from fitting.
- `alignment.imageSize`: `[width, height]`, written by the tool to detect resized or replaced images.

Saved `corners` determine placement on reopening. Point pairs alone do not trigger fitting. Unsaved alignment state persists for the app session, keyed to the block and image. Editing the block YAML discards that state.

## Coordinate output

In **Match points**, the output below the panes matches the clipboard's complete alignment YAML and updates with point edits, fitting, undo, and redo. **Adjust image** displays coordinate snippets for ordinary `places` overlays.

| Format    | Coordinate order                                |
| --------- | ----------------------------------------------- |
| `corners` | nwLat,nwLng,neLat,neLng,seLat,seLng,swLat,swLng |
| `bounds`  | swLat,swLng,neLat,neLng                         |

`bounds` appears only for axis-aligned images.

~~~places
overlays:
  - path: 02 - Overlays/scranton-1889-usgs-topo.jpg
    corners: 41.42,-75.67,41.42,-75.65,41.40,-75.65,41.40,-75.67
~~~

## Related documentation

- `places-overlay-help` - Image overlay display options
