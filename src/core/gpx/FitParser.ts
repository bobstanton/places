import { Waypoint } from "places-shared/place";
import type { MetricWindow } from "places-shared/settings";
import { meters, km, kph } from "places-shared/units";
import { base64ToBytes } from "places-shared/utils";
import { decodeFitMessages, type FitFieldValue, type FitMessage } from "./FitDecoder";
import type { TrackDocumentModel } from "./TrackDocumentModel";
import { TrackPointProcessor, type RawTrackPoint } from "./TrackPointProcessor";
import type { SegmentedTrackData } from "./GpxParser";

const MESSAGE_SPORT = 12;
const MESSAGE_SESSION = 18;
const MESSAGE_RECORD = 20;
const MESSAGE_EVENT = 21;
const MESSAGE_COURSE = 31;
const MESSAGE_COURSE_POINT = 32;

const RECORD_POSITION_LAT = 0;
const RECORD_POSITION_LONG = 1;
const RECORD_ALTITUDE = 2;
const RECORD_HEART_RATE = 3;
const RECORD_CADENCE = 4;
const RECORD_DISTANCE = 5;
const RECORD_SPEED = 6;
const RECORD_POWER = 7;
const RECORD_TEMPERATURE = 13;
const RECORD_ENHANCED_SPEED = 73;
const RECORD_ENHANCED_ALTITUDE = 78;
const FIELD_TIMESTAMP = 253;

const EVENT_TYPE_FIELD = 1;
const EVENT_FIELD = 0;
const EVENT_TIMER = 0;
const EVENT_TYPE_START = 0;

const COURSE_POINT_LAT = 1;
const COURSE_POINT_LONG = 2;
const COURSE_POINT_TYPE = 4;
const COURSE_POINT_NAME = 5;

const NAME_FIELD = 5;
const SPORT_NAME_FIELD = 3;
const SPORT_FIELD = 0;
const SESSION_SPORT_FIELD = 5;

// FIT stores angles as semicircles over the full 32-bit signed range.
const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

// FIT timestamps count seconds from 1989-12-31T00:00:00Z.
const FIT_EPOCH_OFFSET_SECONDS = 631065600;

// Altitude is stored scaled by 5 with a 500 m offset, in both the 16-bit and enhanced 32-bit fields.
const ALTITUDE_SCALE = 5;
const ALTITUDE_OFFSET_METERS = 500;

// Distance is centimeters and speed is millimeters per second, in both the
// 16-bit and enhanced 32-bit fields.
const DISTANCE_SCALE_PER_METER = 100;
const SPEED_SCALE_PER_METER_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;

const SPORT_NAMES: Record<number, string> = {
  1: 'Running', 2: 'Cycling', 5: 'Swimming', 11: 'Walking', 12: 'Cross-country skiing',
  13: 'Alpine skiing', 14: 'Snowboarding', 15: 'Rowing', 16: 'Mountaineering', 17: 'Hiking',
  19: 'Paddling', 21: 'E-biking', 22: 'Motorcycling', 23: 'Boating', 24: 'Driving',
  27: 'Horseback riding', 30: 'Inline skating', 31: 'Rock climbing', 32: 'Sailing',
  33: 'Ice skating', 35: 'Snowshoeing', 36: 'Snowmobiling', 37: 'Stand-up paddleboarding',
  38: 'Surfing', 41: 'Kayaking', 42: 'Rafting', 43: 'Windsurfing', 44: 'Kitesurfing',
};

const COURSE_POINT_TYPES: Record<number, string> = {
  0: 'Generic', 1: 'Summit', 2: 'Valley', 3: 'Water', 4: 'Food', 5: 'Danger', 6: 'Left',
  7: 'Right', 8: 'Straight', 9: 'First aid', 10: 'Fourth category', 11: 'Third category',
  12: 'Second category', 13: 'First category', 14: 'Hors category', 15: 'Sprint',
  16: 'Left fork', 17: 'Right fork', 18: 'Middle fork', 19: 'Slight left', 20: 'Sharp left',
  21: 'Slight right', 22: 'Sharp right', 23: 'U-turn', 24: 'Segment start', 25: 'Segment end',
};

export class FitParser {
  static parseModel(content: string | Uint8Array): TrackDocumentModel {
    const messages = decodeFitMessages(typeof content === 'string' ? base64ToBytes(content) : content);
    const segments = this.readSegments(messages);
    const name = this.readName(messages);

    return {
      metadata: { name },
      tracks: segments.length > 0 ? [{ name, segments }] : [],
      routes: [],
      waypoints: this.readCoursePoints(messages),
    };
  }

  static parse(content: string | Uint8Array, speedWindow?: MetricWindow): SegmentedTrackData {
    return this.trackFromModel(this.parseModel(content), speedWindow);
  }

  static trackFromModel(model: TrackDocumentModel, speedWindow?: MetricWindow): SegmentedTrackData {
    const segments = model.tracks.flatMap(track => track.segments);
    const waypoints = model.waypoints;

    if (segments.length === 0 && waypoints.length === 0) {
      throw new Error('No position records or course points found in FIT file');
    }

    if (segments.length === 0) {
      return {
        points: [],
        metrics: { distance: km(0), elevationGain: meters(0), elevationLoss: meters(0) },
        waypoints,
        metadata: { name: model.metadata.name, source: 'fit' },
      };
    }

    const { points, metrics } = TrackPointProcessor.processSegmentedTrackData(segments, speedWindow);

    return {
      points,
      segments: segments.length > 1 ? segments.map(segment => TrackPointProcessor.createTrackPoints(segment, speedWindow)) : undefined,
      metrics,
      waypoints,
      metadata: { name: model.metadata.name, source: 'fit' },
    };
  }

  private static readSegments(messages: FitMessage[]): RawTrackPoint[][] {
    const restarts = this.readTimerRestarts(messages);
    const segments: RawTrackPoint[][] = [];
    let current: RawTrackPoint[] = [];
    let nextRestart = 0;

    for (const message of messages) {
      if (message.globalMessageNumber !== MESSAGE_RECORD) continue;
      const point = this.readRecordPoint(message);

      if (!point) continue;

      const timestamp = numberField(message, FIELD_TIMESTAMP);
      let resumed = false;

      while (timestamp !== undefined && nextRestart < restarts.length && timestamp >= restarts[nextRestart]) {
        nextRestart += 1;
        resumed = true;
      }

      if (resumed && current.length > 0) {
        segments.push(current);
        current = [];
      }

      current.push(point);
    }

    if (current.length > 0) segments.push(current);

    return segments;
  }

  private static readTimerRestarts(messages: FitMessage[]): number[] {
    const restarts: number[] = [];
    let stopped = false;

    for (const message of messages) {
      if (message.globalMessageNumber !== MESSAGE_EVENT) continue;
      if (numberField(message, EVENT_FIELD) !== EVENT_TIMER) continue;
      const eventType = numberField(message, EVENT_TYPE_FIELD);
      const timestamp = numberField(message, FIELD_TIMESTAMP);

      if (eventType === EVENT_TYPE_START) {
        if (stopped && timestamp !== undefined) restarts.push(timestamp);
        stopped = false;
      } else {
        stopped = true;
      }
    }

    return restarts;
  }

  private static readRecordPoint(message: FitMessage): RawTrackPoint | null {
    const latitude = numberField(message, RECORD_POSITION_LAT);
    const longitude = numberField(message, RECORD_POSITION_LONG);

    if (latitude === undefined || longitude === undefined) return null;

    const altitude = numberField(message, RECORD_ENHANCED_ALTITUDE) ?? numberField(message, RECORD_ALTITUDE);
    const timestamp = numberField(message, FIELD_TIMESTAMP);
    const distance = numberField(message, RECORD_DISTANCE);
    const speed = numberField(message, RECORD_ENHANCED_SPEED) ?? numberField(message, RECORD_SPEED);

    return {
      latitude: latitude * SEMICIRCLES_TO_DEGREES,
      longitude: longitude * SEMICIRCLES_TO_DEGREES,
      elevationMeters: altitude === undefined ? undefined : meters(altitude / ALTITUDE_SCALE - ALTITUDE_OFFSET_METERS),
      time: timestamp === undefined ? undefined : fitTimestampToDate(timestamp),
      deviceDistanceKm: distance === undefined ? undefined : km(distance / DISTANCE_SCALE_PER_METER / 1000),
      deviceSpeedKph: speed === undefined ? undefined : kph(speed / SPEED_SCALE_PER_METER_PER_SECOND * SECONDS_PER_HOUR / 1000),
      heartRateBpm: numberField(message, RECORD_HEART_RATE),
      cadenceRpm: numberField(message, RECORD_CADENCE),
      powerWatts: numberField(message, RECORD_POWER),
      temperatureCelsius: numberField(message, RECORD_TEMPERATURE),
    };
  }

  private static readCoursePoints(messages: FitMessage[]): Waypoint[] {
    const waypoints: Waypoint[] = [];

    for (const message of messages) {
      if (message.globalMessageNumber !== MESSAGE_COURSE_POINT) continue;
      const latitude = numberField(message, COURSE_POINT_LAT);
      const longitude = numberField(message, COURSE_POINT_LONG);

      if (latitude === undefined || longitude === undefined) continue;

      const pointType = numberField(message, COURSE_POINT_TYPE);
      const timestamp = numberField(message, FIELD_TIMESTAMP);

      waypoints.push({
        name: stringField(message, COURSE_POINT_NAME) ?? '',
        lat: latitude * SEMICIRCLES_TO_DEGREES,
        lon: longitude * SEMICIRCLES_TO_DEGREES,
        type: pointType === undefined ? undefined : COURSE_POINT_TYPES[pointType],
        time: timestamp === undefined ? undefined : fitTimestampToDate(timestamp),
      });
    }

    return waypoints;
  }

  private static readName(messages: FitMessage[]): string | undefined {
    const course = messages.find(message => message.globalMessageNumber === MESSAGE_COURSE);
    const courseName = course && stringField(course, NAME_FIELD);

    if (courseName) return courseName;

    const sport = messages.find(message => message.globalMessageNumber === MESSAGE_SPORT);
    const sportName = sport && stringField(sport, SPORT_NAME_FIELD);

    if (sportName) return sportName;

    const sportValue = (sport && numberField(sport, SPORT_FIELD))
      ?? numberField(messages.find(message => message.globalMessageNumber === MESSAGE_SESSION), SESSION_SPORT_FIELD);

    return sportValue === undefined ? undefined : SPORT_NAMES[sportValue];
  }
}

export function fitTimestampToDate(timestamp: number): Date {
  return new Date((timestamp + FIT_EPOCH_OFFSET_SECONDS) * 1000);
}

function numberField(message: FitMessage | undefined, fieldNumber: number): number | undefined {
  const value: FitFieldValue | undefined = message?.fields.get(fieldNumber);

  return typeof value === 'number' ? value : undefined;
}

function stringField(message: FitMessage, fieldNumber: number): string | undefined {
  const value: FitFieldValue | undefined = message.fields.get(fieldNumber);

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
