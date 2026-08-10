---
id: elevation-help
title: Places Elevation Help
---

# Places Elevation Help

Replace or add elevation data for a track and compare with the current elevation profile if present.

{{dynamic:elevationProviders}}

## Basic Usage

~~~places-elevation
track: [[Pretzel Day Walk]]
~~~

## Settings

| Setting    | Description                                                                   | Examples                                       |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| track      | Track note or file to populate. Defaults to the current note.                 | `[[Pretzel Day Walk]]`                         |
| provider   | Elevation service to use. Defaults to the first available elevation provider. | autocomplete suggests installed providers      |
| height     | Preview chart height                                                          | **320px**, 400px                               |
| width      | Preview chart width                                                           | **100%**, 800px                                |
| title      | Chart title                                                                   | "Elevation Replacement Preview"                |
| showGrid   | Display chart grid lines                                                      | **true**, false                                |
| showPoints | Show individual data points                                                   | **false**, true                                |
| smoothing  | Smooth chart lines                                                            | **true**, false                                |
| fillArea   | Shade the area under chart lines                                              | **false**, true                                |
| autorefresh | Re-render when the vault index changes                                        | **true**, false                                |
