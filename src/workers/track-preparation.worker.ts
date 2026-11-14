import { GpxParser, parseTrackContent } from 'places/core';
import type { TrackPreparationRequest, TrackPreparationResponse } from './TrackPreparationProtocol';
import { packTrackData } from './PackedTrackData';

self.onmessage = (event: MessageEvent<TrackPreparationRequest>) => {
  const { input, speedWindow } = event.data;
  let response: TrackPreparationResponse;

  try {
    response = { track: packTrackData(input.format === 'gpx-model'
      ? GpxParser.fromModel(input.model, speedWindow)
      : parseTrackContent(input, speedWindow)) };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }

  self.postMessage(response, { transfer: 'track' in response ? [response.track.values.buffer, response.track.present.buffer] : [] });
};
