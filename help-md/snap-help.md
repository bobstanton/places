---
id: snap-help
title: Places Snap Help
---

# Places Snap Help

Match and align track points to the closest roads and compare with the current track.

{{dynamic:snapProviders}}

## Basic Usage

~~~places-snap
track: [[Morning Run - Monday]]
~~~

The original track is drawn as a dashed gray line and the snapped track as a solid green line. When `track` is omitted, the current note's overlay is used. Points with no road within the radius are kept at their original location.

## Settings

| Setting         | Description                                                                                                                                                                            | Examples                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| track           | Track note or file to snap. Defaults to the current note.                                                                                                                              | `[[Morning Run - Monday]]`                           |
| provider        | Snap service to use. Defaults to the first available provider with snap support.                                                                                                       | autocomplete suggests installed snap providers       |
| mode            | Travel mode. Decides which ways are eligible: `walk` and `bike` include footpaths, tracks, and cycleways; `drive` is roads only                                                        | **drive**, walk, bike                                |
| radius          | Search radius around each point. A bare number uses the units setting; an explicit unit overrides it. Defaults to the provider's own default                                           | 300m, 500m, 0.2mi                                    |
| costing         | Valhalla costing name, overriding the one `mode` resolves to. Reaches costings `mode` cannot express                                                                                   | pedestrian, bicycle, auto, truck, bus, motor_scooter |
| costingOptions  | Options for the effective costing, passed through verbatim                                                                                                                             | walkway_factor: 0.5                                  |
| timestamps      | Send each point's recorded time, letting elapsed time constrain the match. On by default when the track has times                                                                      | **true**, false                                      |
| shapeMatch      | Valhalla matching strategy. `edge_walk` suits a trace that already follows the network                                                                                                 | **map_snap**, edge_walk, walk_or_snap                |
| tidy            | Collapse near-duplicate and stationary points before matching                                                                                                                          | true, **false**                                      |
| exclude         | Way classes to keep the match off                                                                                                                                                      | motorway, toll, ferry                                |
| traceOptions    | Valhalla trace options tuning the matcher itself, passed through verbatim                                                                                                              | search_radius: 35                                    |
| wayDetails      | Report the named ways and surfaces the match ran along                                                                                                                                 | true, **false**                                      |
| mapProvider     | Map used for the preview. Defaults to the global default provider.                                                                                                                     | {{dynamic:mapProviderNames}}                         |
| height          | Preview map height                                                                                                                                                                     | **400px**, 500px                                     |
| width           | Width of everything the block renders, its legend and info included. A percentage measures the note's width, vw the window's                                                           | **100%**, 800px                                      |
| poiDiscovery    | Enable clicking base-map POIs on the preview map. Defaults off for this utility map                                                                                                    | true, **false**                                      |
| style           | Map style (provider-specific)                                                                                                                                                          | varies by provider                                   |
| queryParameters | UI controls that adjust the block without editing it; `queryParametersPosition`, `queryParametersLayout`, and `queryParametersCollapsed` place them. See `places-queryparameters-help` | `- name: limit`                                      |


## Costing

Costing options are passed through verbatim to the provider, see Valhalla's documentation for option details: [https://valhalla.github.io/valhalla/api/route/api-reference/#costing-options](https://valhalla.github.io/valhalla/api/route/api-reference/#costing-options)

~~~places-snap
track: [[Morning Run - Monday]]
mode: walk
costingOptions:
  walkway_factor: 0.5
  driveway_factor: 5
~~~

