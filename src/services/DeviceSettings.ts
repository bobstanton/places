// Pure data with no obsidian imports; safe for web workers.
export interface DeviceOptimalSettings {
  targetPointsPerTrack: number;
  // Douglas-Peucker tolerance in degrees
  simplificationTolerance: number;
}

const MOBILE_SETTINGS: DeviceOptimalSettings = {
  targetPointsPerTrack: 100,
  simplificationTolerance: 0.0001 // ~10 meters
};

const DESKTOP_SETTINGS: DeviceOptimalSettings = {
  targetPointsPerTrack: 200,
  simplificationTolerance: 0.00005 // ~5 meters
};

// isMobile is the result of Platform.isMobile, determined at plugin startup.
export function getDeviceOptimalSettings(isMobile: boolean): DeviceOptimalSettings {
  return isMobile ? MOBILE_SETTINGS : DESKTOP_SETTINGS;
}
