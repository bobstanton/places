import { Waypoint } from "places-shared/place";
import type { MetricWindow } from "places-shared/settings";
import { meters, km } from "places-shared/units";
import { TrackPointProcessor, type RawTrackPoint, type TrackData, type TrackPoint } from "./TrackPointProcessor";

export interface SegmentedTrackData extends TrackData {
  segments?: TrackPoint[][];
}

export interface GpxMetadata {
  name?: string;
  description?: string;
  author?: string;
}

export interface GpxTrackModel {
  name?: string;
  description?: string;
  segments: RawTrackPoint[][];
}

export interface GpxRouteModel {
  name?: string;
  description?: string;
  points: RawTrackPoint[];
}

// Lossless-for-Places representation of the GPX XML.
export interface GpxDocumentModel {
  metadata: GpxMetadata;
  tracks: GpxTrackModel[];
  routes: GpxRouteModel[];
  waypoints: Waypoint[];
}

export class GpxParser {
  private static readonly GENERIC_TRACK_NAMES = new Set([
    'trail planner map', 'trail planner', 'alltrails', 'all trails', 'gaia gps',
    'garmin connect', 'strava', 'komoot', 'wikiloc', 'plotaroute', 'ride with gps',
    'mapmyride', 'mapmyhike', 'mapmywalk', 'default track', 'untitled', 'new track'
  ]);

  // Parse GPX XML exactly once into the model used by every GPX consumer.
  static parseModel(gpxContent: string): GpxDocumentModel {
    const doc = new DOMParser().parseFromString(gpxContent, "text/xml");
    const parserError = doc.querySelector("parsererror");
    if (parserError) throw new Error(`Invalid GPX XML: ${parserError.textContent}`);

    const metadata: GpxMetadata = {
      name: this.text(doc.querySelector("metadata > name")),
      description: this.text(doc.querySelector("metadata > desc")),
      author: this.text(doc.querySelector("metadata > author > name")),
    };
    const tracks = Array.from(doc.querySelectorAll("trk")).map(track => ({
      name: this.cleanTrackName(this.text(track.querySelector("name"))),
      description: this.text(track.querySelector("desc")),
      segments: Array.from(track.querySelectorAll("trkseg"))
        .map(segment => this.parsePoints(segment.querySelectorAll("trkpt")))
        .filter(segment => segment.length > 0),
    }));
    const routes = Array.from(doc.querySelectorAll("rte")).map(route => ({
      name: this.cleanTrackName(this.text(route.querySelector("name"))),
      description: this.text(route.querySelector("desc")),
      points: this.parsePoints(route.querySelectorAll("rtept")),
    }));

    return { metadata, tracks, routes, waypoints: this.parseWaypoints(doc.querySelectorAll("wpt")) };
  }

  static parseAllTracks(gpxContent: string, speedWindow?: MetricWindow): TrackData[] {
    const model = this.parseModel(gpxContent);
    if (model.tracks.length === 0 && model.routes.length === 0) {
      throw new Error("No tracks or routes found in GPX file");
    }

    const totalElements = model.tracks.length + model.routes.length;
    const results: TrackData[] = [];
    model.tracks.forEach((track, index) => {
      const points = track.segments.flat();
      if (points.length === 0) return;
      results.push(this.toTrackData(
        points,
        track.segments,
        track.name || (totalElements > 1 ? `Track ${index + 1}` : undefined),
        track.description,
        results.length === 0 ? model.waypoints : [],
        speedWindow,
      ));
    });
    model.routes.forEach((route, index) => {
      if (route.points.length === 0) return;
      results.push(this.toTrackData(
        route.points,
        [route.points],
        route.name || (totalElements > 1 ? `Route ${index + 1}` : undefined),
        route.description,
        results.length === 0 ? model.waypoints : [],
        speedWindow,
      ));
    });
    if (results.length === 0) throw new Error("No valid track or route points found");
    return results;
  }

  static parse(gpxContent: string, speedWindow?: MetricWindow): SegmentedTrackData {
    const model = this.parseModel(gpxContent);
    // Every track, not just the first: a trail exported as one <trk> per
    // stretch is one route, and reading only the leading track silently
    // discarded the rest of it - stats, chart, and elevation profile included.
    const tracks = model.tracks.filter(candidate => candidate.segments.some(segment => segment.length > 0));
    const route = tracks.length === 0 ? model.routes.find(candidate => candidate.points.length > 0) : undefined;
    const segments = tracks.length > 0
      ? tracks.flatMap(candidate => candidate.segments.filter(segment => segment.length > 0))
      : (route ? [route.points] : []);
    const rawPoints = segments.flat();
    const name = tracks[0]?.name ?? route?.name ?? this.cleanTrackName(model.metadata.name);
    const description = tracks[0]?.description ?? route?.description ?? model.metadata.description;

    if (rawPoints.length === 0 && model.waypoints.length === 0) {
      throw new Error("No track points, route points, or waypoints found in GPX");
    }
    if (rawPoints.length === 0) {
      return {
        points: [],
        metrics: { distance: km(0), elevationGain: meters(0), elevationLoss: meters(0) },
        waypoints: model.waypoints,
        metadata: { name, description, source: 'gpx' },
      };
    }
    return this.toTrackData(rawPoints, segments, name, description, model.waypoints, speedWindow);
  }

  static getPrimaryPathPoints(model: GpxDocumentModel): RawTrackPoint[] {
    const trackPoints = model.tracks.flatMap(track => track.segments.flat());
    return trackPoints.length > 0 ? trackPoints : model.routes.flatMap(route => route.points);
  }

  static serializeWaypoints(model: GpxDocumentModel): string {
    const metadataFields = [
      this.xmlElement('name', model.metadata.name, 4),
      this.xmlElement('desc', model.metadata.description, 4),
      model.metadata.author
        ? `    <author>\n${this.xmlElement('name', model.metadata.author, 6)}\n    </author>`
        : '',
    ].filter(Boolean);
    const metadata = metadataFields.length > 0
      ? `\n  <metadata>\n${metadataFields.join('\n')}\n  </metadata>`
      : '';
    const waypoints = model.waypoints.map(waypoint => {
      const fields = [
        waypoint.elevation === undefined ? '' : this.xmlElement('ele', String(waypoint.elevation), 4),
        waypoint.time ? this.xmlElement('time', waypoint.time.toISOString(), 4) : '',
        this.xmlElement('name', waypoint.name, 4),
        this.xmlElement('cmt', waypoint.comment, 4),
        this.xmlElement('desc', waypoint.description, 4),
        this.xmlElement('sym', waypoint.iconUrl ?? waypoint.symbol, 4),
        this.xmlElement('type', waypoint.type, 4),
        waypoint.link ? `    <link href="${this.escapeXml(waypoint.link)}" />` : '',
      ].filter(Boolean);
      return `  <wpt lat="${String(waypoint.lat)}" lon="${String(waypoint.lon)}">\n${fields.join('\n')}\n  </wpt>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Places plugin" xmlns="http://www.topografix.com/GPX/1/1">${metadata}${waypoints.length ? `\n${waypoints.join('\n')}` : ''}\n</gpx>`;
  }

  private static toTrackData(rawPoints: RawTrackPoint[], rawSegments: RawTrackPoint[][], name: string | undefined, description: string | undefined, waypoints: Waypoint[], speedWindow?: MetricWindow): SegmentedTrackData {
    const { points, metrics } = TrackPointProcessor.processSegmentedTrackData(
      rawSegments.length > 0 ? rawSegments : [rawPoints],
      speedWindow,
    );
    return {
      points,
      segments: rawSegments.length > 1 ? rawSegments.map(segment => TrackPointProcessor.createTrackPoints(segment, speedWindow)) : undefined,
      metrics,
      waypoints,
      metadata: { name, description, source: 'gpx' },
    };
  }

  private static parsePoints(elements: Iterable<Element>): RawTrackPoint[] {
    return Array.from(elements, element => this.parsePoint(element)).filter((point): point is RawTrackPoint => point !== null);
  }

  private static parsePoint(element: Element): RawTrackPoint | null {
    const latitude = Number.parseFloat(element.getAttribute("lat") ?? "");
    const longitude = Number.parseFloat(element.getAttribute("lon") ?? "");
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const elevationValue = Number.parseFloat(this.text(element.querySelector("ele")) ?? "");
    const timeValue = this.text(element.querySelector("time"));
    const time = timeValue ? new Date(timeValue) : undefined;
    return {
      latitude,
      longitude,
      elevationMeters: Number.isFinite(elevationValue) ? meters(elevationValue) : undefined,
      time: time && Number.isFinite(time.getTime()) ? time : undefined,
    };
  }

  private static parseWaypoints(elements: Iterable<Element>): Waypoint[] {
    const waypoints: Waypoint[] = [];
    for (const element of elements) {
      const lat = Number.parseFloat(element.getAttribute("lat") ?? "");
      const lon = Number.parseFloat(element.getAttribute("lon") ?? "");
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const rawSymbol = this.text(element.querySelector("sym"));
      const symbolIsUrl = rawSymbol?.startsWith('http://') || rawSymbol?.startsWith('https://');
      const elevationValue = Number.parseFloat(this.text(element.querySelector("ele")) ?? "");
      const timeValue = this.text(element.querySelector("time"));
      const time = timeValue ? new Date(timeValue) : undefined;
      waypoints.push({
        name: this.text(element.querySelector("name")) ?? "",
        lat,
        lon,
        description: this.text(element.querySelector("desc")),
        symbol: symbolIsUrl ? '📍' : rawSymbol,
        iconUrl: symbolIsUrl ? rawSymbol : undefined,
        type: this.text(element.querySelector("type")),
        elevation: Number.isFinite(elevationValue) ? meters(elevationValue) : undefined,
        time: time && Number.isFinite(time.getTime()) ? time : undefined,
        comment: this.text(element.querySelector("cmt")),
        link: element.querySelector("link")?.getAttribute("href") ?? undefined,
      });
    }
    return waypoints;
  }

  private static text(element: Element | null): string | undefined {
    const value = element?.textContent?.trim();
    return value || undefined;
  }

  private static xmlElement(name: string, value: string | undefined, indent: number): string {
    return value ? `${' '.repeat(indent)}<${name}>${this.escapeXml(value)}</${name}>` : '';
  }

  private static escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  private static cleanTrackName(rawName?: string): string | undefined {
    if (!rawName) return undefined;
    const cleaned = rawName.trim().toLowerCase();
    if (this.GENERIC_TRACK_NAMES.has(cleaned) || /^(track|route)_\d+$/i.test(cleaned)) return undefined;
    return rawName.trim();
  }
}
