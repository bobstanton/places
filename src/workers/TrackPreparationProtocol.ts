import type { TrackContent, TrackDocumentModel } from 'places/core';
import type { PackedTrackData } from './PackedTrackData';
import type { MetricWindow } from 'places-shared/settings';

export interface TrackPreparationRequest {
  input: TrackContent | { format: 'gpx-model'; model: TrackDocumentModel };
  speedWindow: MetricWindow;
}

export type TrackPreparationResponse = { track: PackedTrackData } | { error: string };
