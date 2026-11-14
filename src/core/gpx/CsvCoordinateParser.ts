import { meters } from 'places-shared/units';
import type { RawTrackPoint } from './TrackPointProcessor';

const LATITUDE_HEADERS = new Set(['lat', 'latitude']);
const LONGITUDE_HEADERS = new Set(['lon', 'lng', 'longitude']);
const ELEVATION_HEADERS = new Set(['ele', 'elevation', 'alt', 'altitude']);
const TIME_HEADERS = new Set(['time', 'timestamp']);

export interface ParsedCsvCoordinateRow {
  values: string[];
  latitude: number;
  longitude: number;
  elevation?: number;
  time?: Date;
}

export interface ParsedCsvCoordinates {
  rows: ParsedCsvCoordinateRow[];
  rawPoints: RawTrackPoint[];
  skippedRows: number;
  totalDataRows: number;
  header: string[];
  columnIndexes: {
    latitude: number;
    longitude: number;
    elevation: number;
    time: number;
  };
}

export function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  const currentChars: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(currentChars.join('').trim());
      currentChars.length = 0;
    } else {
      currentChars.push(char);
    }
  }

  values.push(currentChars.join('').trim());

  return values;
}

export function parseCsvCoordinates(csvContent: string, errorPrefix = 'CSV'): ParsedCsvCoordinates {
  const lines = csvContent.split('\n').filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error(`${errorPrefix} must have a header row and at least one data row`);
  }

  const header = parseCsvLine(lines[0]).map(col => col.trim().toLowerCase());
  const latIndex = header.findIndex(col => LATITUDE_HEADERS.has(col));
  const lonIndex = header.findIndex(col => LONGITUDE_HEADERS.has(col));
  const elevIndex = header.findIndex(col => ELEVATION_HEADERS.has(col));
  const timeIndex = header.findIndex(col => TIME_HEADERS.has(col));

  if (latIndex === -1 || lonIndex === -1) {
    throw new Error(`${errorPrefix} must have latitude and longitude columns`);
  }

  const rows: ParsedCsvCoordinateRow[] = [];
  const rawPoints: RawTrackPoint[] = [];
  let skippedRows = 0;

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const latitude = parseFloat(values[latIndex]);
    const longitude = parseFloat(values[lonIndex]);

    if (isNaN(latitude) || isNaN(longitude)) {
      skippedRows++;
      continue;
    }

    const point: RawTrackPoint = { latitude, longitude };
    const row: ParsedCsvCoordinateRow = { values, latitude, longitude };

    if (elevIndex !== -1 && values[elevIndex]) {
      const elevation = parseFloat(values[elevIndex]);

      if (!isNaN(elevation)) {
        row.elevation = elevation;
        point.elevationMeters = meters(elevation);
      }
    }

    if (timeIndex !== -1 && values[timeIndex]) {
      const time = new Date(values[timeIndex]);

      if (!isNaN(time.getTime())) {
        row.time = time;
        point.time = time;
      }
    }

    rows.push(row);
    rawPoints.push(point);
  }

  return {
    rows,
    rawPoints,
    skippedRows,
    totalDataRows: lines.length - 1,
    header,
    columnIndexes: {
      latitude: latIndex,
      longitude: lonIndex,
      elevation: elevIndex,
      time: timeIndex,
    },
  };
}
