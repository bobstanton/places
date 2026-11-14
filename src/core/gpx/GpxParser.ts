import { Waypoint } from "places-shared/place";
import type { MetricWindow } from "places-shared/settings";
import { meters, km, kph, type KilometersPerHour } from "places-shared/units";
import { TrackPointProcessor, type RawTrackPoint, type TrackData, type TrackPoint } from "./TrackPointProcessor";
import type { TrackDocumentModel } from "./TrackDocumentModel";

export interface SegmentedTrackData extends TrackData {
  segments?: TrackPoint[][];
}

export class GpxParser {
  private static readonly GENERIC_TRACK_NAMES = new Set([
    'trail planner map', 'trail planner', 'alltrails', 'all trails', 'gaia gps',
    'garmin connect', 'strava', 'komoot', 'wikiloc', 'plotaroute', 'ride with gps',
    'mapmyride', 'mapmyhike', 'mapmywalk', 'default track', 'untitled', 'new track'
  ]);

  static parseModel(gpxContent: string): TrackDocumentModel {
    return this.modelFromDocument(this.parseXml(gpxContent));
  }

  private static parseXml(gpxContent: string): Document {
    const doc = new DOMParser().parseFromString(gpxContent, "text/xml");
    const parserError = doc.querySelector("parsererror");

    if (parserError) throw new Error(`Invalid GPX XML: ${parserError.textContent}`);
    if (doc.documentElement.localName !== 'gpx') throw new Error('Expected a GPX document');

    return doc;
  }

  private static modelFromDocument(doc: Document): TrackDocumentModel {
    const metadataElement = this.child(doc.documentElement, "metadata");
    const metadata = {
      name: this.text(this.child(metadataElement, "name")),
      description: this.text(this.child(metadataElement, "desc")),
      author: this.text(this.child(this.child(metadataElement, "author"), "name")),
    };
    const tracks = this.children(doc.documentElement, "trk").map(track => ({
      name: this.cleanTrackName(this.text(this.child(track, "name"))),
      description: this.text(this.child(track, "desc")),
      segments: this.children(track, "trkseg")
        .map(segment => this.parsePoints(this.children(segment, "trkpt")))
        .filter(segment => segment.length > 0),
    }));
    const routes = this.children(doc.documentElement, "rte").map(route => ({
      name: this.cleanTrackName(this.text(this.child(route, "name"))),
      description: this.text(this.child(route, "desc")),
      points: this.parsePoints(this.children(route, "rtept")),
    }));

    return { metadata, tracks, routes, waypoints: this.parseWaypoints(this.children(doc.documentElement, "wpt")) };
  }

  static splitSources(gpxContent: string): Array<{ content: string; model: TrackDocumentModel }> {
    const doc = this.parseXml(gpxContent);
    const model = this.modelFromDocument(doc);
    const elements = [...this.children(doc.documentElement, 'trk'), ...this.children(doc.documentElement, 'rte')];
    const paths = new Set(elements);
    const serializer = new XMLSerializer();
    const results: Array<{ content: string; model: TrackDocumentModel }> = [];

    for (const [index, element] of elements.entries()) {
      const track = model.tracks[index];
      const route = model.routes[index - model.tracks.length];

      if (track ? !track.segments.some(segment => segment.length > 0) : !route?.points.length) continue;
      const first = results.length === 0;
      const selected: TrackDocumentModel = {
        metadata: model.metadata,
        tracks: track ? [{ ...track, name: track.name ?? (elements.length > 1 ? `Track ${index + 1}` : undefined) }] : [],
        routes: route ? [{ ...route, name: route.name ?? (elements.length > 1 ? `Route ${index - model.tracks.length + 1}` : undefined) }] : [],
        waypoints: first ? model.waypoints : [],
      };
      let content = gpxContent;

      if (elements.length > 1) {
        const root = doc.documentElement.cloneNode(false) as Element;

        for (const node of Array.from(doc.documentElement.childNodes)) {
          if (node.nodeType === 1) {
            const child = node as Element;

            if (paths.has(child) && child !== element) continue;
            if (!first && child.localName === 'wpt' && child.namespaceURI === root.namespaceURI) continue;
          }

          root.appendChild(node.cloneNode(true));
        }

        content = `<?xml version="1.0" encoding="UTF-8"?>\n${serializer.serializeToString(root)}`;
      }

      results.push({ content, model: selected });
    }

    return results;
  }

  static tracksFromModel(model: TrackDocumentModel, speedWindow?: MetricWindow): TrackData[] {
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
    return this.fromModel(this.parseModel(gpxContent), speedWindow);
  }

  static fromModel(model: TrackDocumentModel, speedWindow?: MetricWindow): SegmentedTrackData {
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

  private static parsePoints(elements: Element[]): RawTrackPoint[] {
    const points: RawTrackPoint[] = [];

    for (const element of elements) {
      const point = this.parsePoint(element);

      if (point) points.push(point);
    }

    return points;
  }

  private static parsePoint(element: Element): RawTrackPoint | null {
    const latitude = Number.parseFloat(element.getAttribute("lat") ?? "");
    const longitude = Number.parseFloat(element.getAttribute("lon") ?? "");

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    let elevationElement: Element | undefined;
    let timeElement: Element | undefined;
    let speedElement: Element | undefined;

    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      switch (child.localName) {
        case "ele": elevationElement ??= child; break;
        case "time": timeElement ??= child; break;
        case "speed": speedElement ??= child; break;
        case "extensions": speedElement ??= this.extensionSpeed(child); break;
      }
    }

    const elevationValue = Number.parseFloat(this.text(elevationElement) ?? "");
    const timeValue = this.text(timeElement);
    const time = timeValue ? new Date(timeValue) : undefined;

    return {
      latitude,
      longitude,
      elevationMeters: Number.isFinite(elevationValue) ? meters(elevationValue) : undefined,
      time: time && Number.isFinite(time.getTime()) ? time : undefined,
      deviceSpeedKph: this.reportedSpeed(speedElement),
    };
  }

  private static extensionSpeed(element: Element): Element | undefined {
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      if (child.localName === "speed") return child;
      const nested = this.extensionSpeed(child);

      if (nested) return nested;
    }

    return undefined;
  }

  private static reportedSpeed(element: Element | undefined): KilometersPerHour | undefined {
    if (!element) return undefined;
    const metersPerSecond = Number.parseFloat(element.textContent?.trim() ?? "");

    if (!Number.isFinite(metersPerSecond) || metersPerSecond < 0) return undefined;

    return kph(metersPerSecond * 3.6);
  }

  private static parseWaypoints(elements: Element[]): Waypoint[] {
    const waypoints: Waypoint[] = [];

    for (const element of elements) {
      const lat = Number.parseFloat(element.getAttribute("lat") ?? "");
      const lon = Number.parseFloat(element.getAttribute("lon") ?? "");

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      let nameElement: Element | undefined;
      let descriptionElement: Element | undefined;
      let symbolElement: Element | undefined;
      let typeElement: Element | undefined;
      let elevationElement: Element | undefined;
      let timeElement: Element | undefined;
      let commentElement: Element | undefined;
      let linkElement: Element | undefined;

      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        switch (child.localName) {
          case "name": nameElement ??= child; break;
          case "desc": descriptionElement ??= child; break;
          case "sym": symbolElement ??= child; break;
          case "type": typeElement ??= child; break;
          case "ele": elevationElement ??= child; break;
          case "time": timeElement ??= child; break;
          case "cmt": commentElement ??= child; break;
          case "link": linkElement ??= child; break;
        }
      }

      const rawSymbol = this.text(symbolElement);
      const symbolIsUrl = rawSymbol?.startsWith('http://') || rawSymbol?.startsWith('https://');
      const elevationValue = Number.parseFloat(this.text(elevationElement) ?? "");
      const timeValue = this.text(timeElement);
      const time = timeValue ? new Date(timeValue) : undefined;

      waypoints.push({
        name: this.text(nameElement) ?? "",
        lat,
        lon,
        description: this.text(descriptionElement),
        symbol: symbolIsUrl ? '📍' : rawSymbol,
        iconUrl: symbolIsUrl ? rawSymbol : undefined,
        type: this.text(typeElement),
        elevation: Number.isFinite(elevationValue) ? meters(elevationValue) : undefined,
        time: time && Number.isFinite(time.getTime()) ? time : undefined,
        comment: this.text(commentElement),
        link: linkElement?.getAttribute("href") ?? undefined,
      });
    }

    return waypoints;
  }

  private static children(scope: Element, name: string): Element[] {
    const matches: Element[] = [];

    for (let child = scope.firstElementChild; child; child = child.nextElementSibling) {
      if (child.localName === name && child.namespaceURI === scope.namespaceURI) matches.push(child);
    }

    return matches;
  }

  private static child(parent: Element | undefined, name: string): Element | undefined {
    if (!parent) return undefined;

    for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
      if (node.localName === name) return node;
    }

    return undefined;
  }

  private static text(element: Element | null | undefined): string | undefined {
    const value = element?.textContent?.trim();

    return value || undefined;
  }

  static cleanTrackName(rawName?: string): string | undefined {
    if (!rawName) return undefined;
    const cleaned = rawName.trim().toLowerCase();

    if (this.GENERIC_TRACK_NAMES.has(cleaned) || /^(track|route)_\d+$/i.test(cleaned)) return undefined;

    return rawName.trim();
  }
}
