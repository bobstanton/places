import type { RawTrackPoint } from "./TrackPointProcessor";
import type { TrackDocumentModel } from "./TrackDocumentModel";

const COORDINATE_DECIMALS = 6;
const ELEVATION_DECIMALS = 2;

export function serializeTrackDocumentToGpx(model: TrackDocumentModel): string {
  const metadata = serializeMetadata(model);
  const waypoints = model.waypoints.map(waypoint => {
    const fields = [
      waypoint.elevation === undefined ? '' : xmlElement('ele', formatNumber(waypoint.elevation, ELEVATION_DECIMALS), 4),
      waypoint.time ? xmlElement('time', waypoint.time.toISOString(), 4) : '',
      xmlElement('name', waypoint.name, 4),
      xmlElement('cmt', waypoint.comment, 4),
      xmlElement('desc', waypoint.description, 4),
      xmlElement('sym', waypoint.iconUrl ?? waypoint.symbol, 4),
      xmlElement('type', waypoint.type, 4),
      waypoint.link ? `    <link href="${escapeXml(waypoint.link)}" />` : '',
    ].filter(Boolean);

    return `  <wpt lat="${formatNumber(waypoint.lat, COORDINATE_DECIMALS)}" lon="${formatNumber(waypoint.lon, COORDINATE_DECIMALS)}">\n${fields.join('\n')}\n  </wpt>`;
  });

  const tracks = model.tracks
    .filter(track => track.segments.some(segment => segment.length > 0))
    .map(track => {
      const header = [xmlElement('name', track.name, 4), xmlElement('desc', track.description, 4)].filter(Boolean);
      const segments = track.segments
        .filter(segment => segment.length > 0)
        .map(segment => `    <trkseg>\n${segment.map(point => serializePoint('trkpt', point, 6)).join('\n')}\n    </trkseg>`);

      return `  <trk>\n${[...header, ...segments].join('\n')}\n  </trk>`;
    });

  const routes = model.routes
    .filter(route => route.points.length > 0)
    .map(route => {
      const header = [xmlElement('name', route.name, 4), xmlElement('desc', route.description, 4)].filter(Boolean);
      const points = route.points.map(point => serializePoint('rtept', point, 4));

      return `  <rte>\n${[...header, ...points].join('\n')}\n  </rte>`;
    });

  const body = [...waypoints, ...tracks, ...routes];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="Places plugin" xmlns="http://www.topografix.com/GPX/1/1">${metadata}`,
    ...body,
    '</gpx>',
  ].join('\n');
}

function serializeMetadata(model: TrackDocumentModel): string {
  const fields = [
    xmlElement('name', model.metadata.name, 4),
    xmlElement('desc', model.metadata.description, 4),
    model.metadata.author ? `    <author>\n${xmlElement('name', model.metadata.author, 6)}\n    </author>` : '',
  ].filter(Boolean);

  return fields.length > 0 ? `\n  <metadata>\n${fields.join('\n')}\n  </metadata>` : '';
}

function serializePoint(tag: string, point: RawTrackPoint, indent: number): string {
  const pad = ' '.repeat(indent);
  const fields = [
    point.elevationMeters === undefined ? '' : xmlElement('ele', formatNumber(point.elevationMeters, ELEVATION_DECIMALS), indent + 2),
    point.time ? xmlElement('time', point.time.toISOString(), indent + 2) : '',
  ].filter(Boolean);
  const body = fields.length > 0 ? `\n${fields.join('\n')}\n${pad}` : '';

  return `${pad}<${tag} lat="${formatNumber(point.latitude, COORDINATE_DECIMALS)}" lon="${formatNumber(point.longitude, COORDINATE_DECIMALS)}">${body}</${tag}>`;
}

function formatNumber(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

function xmlElement(name: string, value: string | undefined, indent: number): string {
  return value ? `${' '.repeat(indent)}<${name}>${escapeXml(value)}</${name}>` : '';
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
